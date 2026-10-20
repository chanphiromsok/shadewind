#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

// The thread an Android `hookAsync` theme switch commits on (the JS thread only publishes the theme). Nothing here knows React
// Native, JNI or Android: the platform's needs (attach the thread to the JVM, free the JNI references a job creates, name the thread,
// report an error) are passed in as hooks, so the queue itself is tested natively (cpp/harness/commit_worker_tests.cpp).

namespace margelo::nitro::shadewind {

/**
 * One worker thread that runs the jobs posted to it, one at a time, in the order they were posted. The thread starts with the first
 * job. Thread safe: any thread may post.
 *
 * A job that throws does not end the thread (an exception leaving a thread ends the process): it is reported to `onError` and the
 * next job runs.
 *
 * The destructor runs the jobs still queued, then joins the thread. The app's instance is never destroyed (its thread would outlive
 * static destruction), the tests' instances are.
 */
class CommitWorker {
 public:
  using Job = std::function<void()>;

  struct Options {
    /** Runs `loop` once, on the worker thread, around everything the thread does (the JVM attach). Default: just `loop()`. */
    std::function<void(const Job& loop)> threadScope;
    /** Runs `job` on the worker thread around each job (a JNI local reference frame). Default: just `job()`. */
    std::function<void(const Job& job)> jobScope;
    /** A job threw; the message is the exception's `what()`. Default: ignored. */
    std::function<void(const std::string& message)> onError;
    /** Called first on the worker thread with `name` (the OS thread name). Default: none. */
    std::function<void(const char* name)> nameThread;
    const char* name = "commit-worker";
    /** Starts the thread with the given body. Default: a std::thread. Tests make it fail. */
    std::function<std::thread(Job body)> spawn;
  };

  CommitWorker() = default;

  explicit CommitWorker(Options options) : _options(std::move(options)) {}

  CommitWorker(const CommitWorker&) = delete;
  CommitWorker& operator=(const CommitWorker&) = delete;

  ~CommitWorker() {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _stopping = true;
    }

    _wake.notify_one();

    if (_thread.joinable()) {
      _thread.join();
    }
  }

  /**
   * Queues `job`. If the thread cannot be started this throws, and the job is not queued (the next post tries again).
   */
  void post(Job job) {
    {
      std::lock_guard<std::mutex> lock(_mutex);

      // before the job is queued: if the thread cannot be created nothing is left half done. The new thread waits for this lock, so
      // it cannot look at the queue before the job is in it.
      if (!_thread.joinable()) {
        _thread = _options.spawn ? _options.spawn([this]() { run(); }) : std::thread([this]() { run(); });
      }

      _queue.push_back(std::move(job));
    }

    _wake.notify_one();
  }

 private:
  void run() {
    if (_options.nameThread) {
      _options.nameThread(_options.name);
    }

    const Job loop = [this]() { loopOverJobs(); };

    if (_options.threadScope) {
      _options.threadScope(loop);
    } else {
      loop();
    }
  }

  void loopOverJobs() {
    for (;;) {
      Job job;

      {
        std::unique_lock<std::mutex> lock(_mutex);

        _wake.wait(lock, [this]() { return _stopping || !_queue.empty(); });

        if (_queue.empty()) {
          return; // stopping, and nothing is left to run
        }

        job = std::move(_queue.front());
        _queue.pop_front();
      }

      runJob(job);
    }
  }

  void runJob(const Job& job) {
    // On the JS thread a failing job reached JS as an error; here an exception that leaves the thread's function ends the process.
    const Job guarded = [this, &job]() {
      try {
        job();
      } catch (const std::exception& error) {
        report(error.what());
      } catch (...) {
        report("unknown exception");
      }
    };

    if (_options.jobScope) {
      _options.jobScope(guarded);
    } else {
      guarded();
    }
  }

  void report(const std::string& message) const {
    if (_options.onError) {
      _options.onError(message);
    }
  }

  const Options _options{};
  std::mutex _mutex;
  std::condition_variable _wake;
  std::deque<Job> _queue;
  bool _stopping = false;
  std::thread _thread;
};

/**
 * Posts a job to a CommitWorker unless one posted through the same CoalescedCommit is still waiting. A job that has not started is
 * replaced by the newest one: for requests of the kind "apply whatever the latest state is" (a theme switch commits the theme the
 * hook holds when the commit starts, so the commit of an older switch queued behind it would do nothing new). Rapid switches then
 * cost one commit waiting, not one per switch.
 *
 * What `post` guarantees: after it returns, a run of a job posted at that moment or later will start. A request that arrives while a
 * job runs is not lost: it queues the next run. The caller must publish the state the job reads (the theme) before calling `post`.
 */
class CoalescedCommit {
 public:
  /** Returns true if this call queued a run, false if it only replaced the job waiting. Throws what `CommitWorker::post` throws. */
  bool post(CommitWorker& worker, CommitWorker::Job job) {
    std::lock_guard<std::mutex> lock(_shared->mutex);

    _shared->newest = std::move(job);

    if (_shared->waiting) {
      return false;
    }

    _shared->waiting = true;

    try {
      // `shared` (not `this`): the run may happen after the owner is gone
      worker.post([shared = _shared]() {
        CommitWorker::Job job;

        {
          std::lock_guard<std::mutex> lock(shared->mutex);

          job = std::move(shared->newest);
          shared->newest = nullptr;
          shared->waiting = false; // from here on a new request queues another run
        }

        job();
      });
    } catch (...) {
      _shared->waiting = false;
      _shared->newest = nullptr;

      throw;
    }

    return true;
  }

 private:
  struct Shared {
    std::mutex mutex;
    bool waiting = false;
    CommitWorker::Job newest;
  };

  std::shared_ptr<Shared> _shared = std::make_shared<Shared>();
};

} // namespace margelo::nitro::shadewind
