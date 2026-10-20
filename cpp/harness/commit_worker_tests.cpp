// cpp/CommitWorker.hpp on its own: the thread Android's `hookAsync` commits on, and the coalescing of rapid switches. No React Native,
// no JNI (the JNI parts are hooks the app passes in; here they are counters), so it builds and runs anywhere with a C++20 compiler
// and googletest: `run-commit-worker-tests.sh` runs it alone, also under ThreadSanitizer.
#include <gtest/gtest.h>

#include "CommitWorker.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

using margelo::nitro::shadewind::CoalescedCommit;
using margelo::nitro::shadewind::CommitWorker;
using namespace std::chrono_literals;

namespace {

// A door the test holds shut to keep the worker busy.
class Gate {
 public:
  void open() {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _open = true;
    }

    _changed.notify_all();
  }

  void wait() {
    std::unique_lock<std::mutex> lock(_mutex);
    _changed.wait(lock, [this]() { return _open; });
  }

 private:
  std::mutex _mutex;
  std::condition_variable _changed;
  bool _open = false;
};

template <typename Condition>
bool eventually(Condition condition, std::chrono::milliseconds limit = 5000ms) {
  const auto end = std::chrono::steady_clock::now() + limit;

  while (!condition()) {
    if (std::chrono::steady_clock::now() > end) {
      return false;
    }

    std::this_thread::sleep_for(1ms);
  }

  return true;
}

// Records what ran, from any thread.
class Log {
 public:
  void add(int value) {
    std::lock_guard<std::mutex> lock(_mutex);
    _values.push_back(value);
  }

  std::vector<int> values() const {
    std::lock_guard<std::mutex> lock(_mutex);
    return _values;
  }

 private:
  mutable std::mutex _mutex;
  std::vector<int> _values;
};

} // namespace

TEST(CommitWorker, RunsJobsInOrderOnOneThreadThatIsNotTheCallers) {
  Log order;
  std::mutex mutex;
  std::vector<std::thread::id> threads;

  {
    CommitWorker worker;

    for (int i = 0; i < 1000; i++) {
      worker.post([&, i]() {
        order.add(i);

        std::lock_guard<std::mutex> lock(mutex);
        threads.push_back(std::this_thread::get_id());
      });
    }
  } // the destructor runs what is queued

  const auto values = order.values();

  ASSERT_EQ(values.size(), 1000u);

  for (int i = 0; i < 1000; i++) {
    ASSERT_EQ(values[i], i) << "job " << i << " ran out of order";
  }

  for (const auto& id : threads) {
    EXPECT_EQ(id, threads.front());
    EXPECT_NE(id, std::this_thread::get_id());
  }
}

TEST(CommitWorker, PostDoesNotWaitForTheJob) {
  Gate release;
  std::atomic<bool> started{false};
  Log order;

  {
    CommitWorker worker;

    worker.post([&]() {
      started = true;
      release.wait();
      order.add(1);
    });

    ASSERT_TRUE(eventually([&]() { return started.load(); }));

    // the first job holds the worker: these return at once (a blocking post would hang the test here)
    worker.post([&]() { order.add(2); });
    worker.post([&]() { order.add(3); });

    EXPECT_TRUE(order.values().empty());

    release.open();
  }

  EXPECT_EQ(order.values(), (std::vector<int>{1, 2, 3}));
}

TEST(CommitWorker, AJobThatThrowsIsReportedAndTheNextJobStillRuns) {
  std::mutex mutex;
  std::vector<std::string> errors;
  std::atomic<int> ran{0};

  {
    CommitWorker::Options options;
    options.onError = [&](const std::string& message) {
      std::lock_guard<std::mutex> lock(mutex);
      errors.push_back(message);
    };

    CommitWorker worker(std::move(options));

    worker.post([]() { throw std::runtime_error("boom"); });
    worker.post([]() { throw 42; });
    worker.post([&]() { ran++; });
  }

  EXPECT_EQ(errors, (std::vector<std::string>{"boom", "unknown exception"}));
  EXPECT_EQ(ran.load(), 1);
}

TEST(CommitWorker, AThrowingJobWithoutAnErrorHookDoesNotEndTheProcess) {
  std::atomic<int> ran{0};

  {
    CommitWorker worker;

    worker.post([]() { throw std::runtime_error("nobody listens"); });
    worker.post([&]() { ran++; });
  }

  EXPECT_EQ(ran.load(), 1);
}

TEST(CommitWorker, TheThreadScopeWrapsTheWholeLoopOnceAndTheJobScopeEachJob) {
  std::atomic<int> threadScopes{0};
  std::atomic<int> jobScopes{0};
  std::atomic<int> insideJobScope{0};
  std::atomic<bool> threadScopeStillOpen{false};
  std::atomic<int> sawTheThreadScopeOpen{0};
  std::thread::id threadScopeThread;
  std::thread::id jobScopeThread;
  std::atomic<int> jobsInScope{0};
  std::atomic<int> jobsOutsideScope{0};

  {
    CommitWorker::Options options;
    options.threadScope = [&](const CommitWorker::Job& loop) {
      threadScopes++;
      threadScopeThread = std::this_thread::get_id();
      threadScopeStillOpen = true;
      loop();
      threadScopeStillOpen = false;
    };
    options.jobScope = [&](const CommitWorker::Job& job) {
      jobScopes++;
      jobScopeThread = std::this_thread::get_id();
      insideJobScope++;
      job();
      insideJobScope--;
    };

    CommitWorker worker(std::move(options));

    for (int i = 0; i < 3; i++) {
      worker.post([&]() {
        (insideJobScope.load() == 1 ? jobsInScope : jobsOutsideScope)++;

        if (threadScopeStillOpen) {
          sawTheThreadScopeOpen++;
        }
      });
    }
  }

  EXPECT_EQ(threadScopes.load(), 1);
  EXPECT_EQ(jobScopes.load(), 3);
  EXPECT_EQ(jobsInScope.load(), 3);
  EXPECT_EQ(jobsOutsideScope.load(), 0);
  EXPECT_EQ(sawTheThreadScopeOpen.load(), 3);
  EXPECT_EQ(threadScopeThread, jobScopeThread);
  EXPECT_NE(threadScopeThread, std::this_thread::get_id());
}

TEST(CommitWorker, TheJobScopeAlsoCoversAJobThatThrows) {
  std::atomic<int> opened{0};
  std::atomic<int> closed{0};

  {
    CommitWorker::Options options;
    options.jobScope = [&](const CommitWorker::Job& job) {
      opened++;
      job();
      closed++; // not reached if the exception got out of the scope
    };

    CommitWorker worker(std::move(options));

    worker.post([]() { throw std::runtime_error("x"); });
  }

  EXPECT_EQ(opened.load(), 1);
  EXPECT_EQ(closed.load(), 1);
}

TEST(CommitWorker, NamesTheThreadFirstOnTheWorkerThread) {
  std::string name;
  std::thread::id namedOn;
  std::thread::id ranOn;

  {
    CommitWorker::Options options;
    options.name = "sw-commit";
    options.nameThread = [&](const char* value) {
      name = value;
      namedOn = std::this_thread::get_id();
    };

    CommitWorker worker(std::move(options));

    worker.post([&]() { ranOn = std::this_thread::get_id(); });
  }

  EXPECT_EQ(name, "sw-commit");
  EXPECT_EQ(namedOn, ranOn);
  EXPECT_NE(namedOn, std::this_thread::get_id());
}

TEST(CommitWorker, TheDestructorRunsTheJobsStillQueuedBeforeItReturns) {
  Gate release;
  std::atomic<int> ran{0};
  std::thread opener;

  {
    CommitWorker worker;

    worker.post([&]() {
      release.wait();
      ran++;
    });

    for (int i = 0; i < 5; i++) {
      worker.post([&]() { ran++; });
    }

    // the worker is still held when the destructor starts
    opener = std::thread([&]() {
      std::this_thread::sleep_for(50ms);
      release.open();
    });
  }

  opener.join();

  EXPECT_EQ(ran.load(), 6);
}

TEST(CommitWorker, AFailedStartThrowsQueuesNothingAndTheNextPostTriesAgain) {
  std::atomic<int> attempts{0};
  Log order;

  {
    CommitWorker::Options options;
    options.spawn = [&](CommitWorker::Job body) -> std::thread {
      if (attempts++ == 0) {
        throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again));
      }

      return std::thread(std::move(body));
    };

    CommitWorker worker(std::move(options));

    EXPECT_THROW(worker.post([&]() { order.add(1); }), std::system_error);

    worker.post([&]() { order.add(2); });
  }

  EXPECT_EQ(attempts.load(), 2);
  EXPECT_EQ(order.values(), (std::vector<int>{2})); // the job of the failed post was not left in the queue
}

TEST(CommitWorker, ManyThreadsMayPostAtOnce) {
  std::atomic<int> ran{0};

  {
    CommitWorker worker;
    std::vector<std::thread> posters;

    for (int t = 0; t < 4; t++) {
      posters.emplace_back([&]() {
        for (int i = 0; i < 500; i++) {
          worker.post([&]() { ran++; });
        }
      });
    }

    for (auto& poster : posters) {
      poster.join();
    }
  }

  EXPECT_EQ(ran.load(), 2000);
}

// ---- CoalescedCommit

TEST(CoalescedCommit, ABurstWhileTheWorkerIsBusyQueuesOneRunOfTheNewestJob) {
  Gate release;
  std::atomic<bool> busy{false};
  Log runs;
  int queued = 0;

  {
    CommitWorker worker;
    CoalescedCommit commit;

    worker.post([&]() {
      busy = true;
      release.wait();
    });

    ASSERT_TRUE(eventually([&]() { return busy.load(); }));

    for (int i = 0; i < 100; i++) {
      queued += commit.post(worker, [&runs, i]() { runs.add(i); }) ? 1 : 0;
    }

    release.open();
  }

  EXPECT_EQ(queued, 1);
  EXPECT_EQ(runs.values(), (std::vector<int>{99})); // one run, of the newest
}

TEST(CoalescedCommit, ARequestWhileAJobRunsIsNotLostItQueuesTheNextRun) {
  Gate release;
  std::atomic<bool> firstRunning{false};
  Log runs;
  bool queuedSecond = false;

  {
    CommitWorker worker;
    CoalescedCommit commit;

    EXPECT_TRUE(commit.post(worker, [&]() {
      firstRunning = true;
      release.wait();
      runs.add(1);
    }));

    ASSERT_TRUE(eventually([&]() { return firstRunning.load(); }));

    // the first job started, so it no longer waits: this is a new run, not a replacement
    queuedSecond = commit.post(worker, [&]() { runs.add(2); });

    release.open();
  }

  EXPECT_TRUE(queuedSecond);
  EXPECT_EQ(runs.values(), (std::vector<int>{1, 2}));
}

TEST(CoalescedCommit, TheNewestRequestIsNeverLostWhateverTheTiming) {
  std::atomic<int> last{-1};
  std::atomic<int> runs{0};
  constexpr int posts = 20000;

  {
    CommitWorker worker;
    CoalescedCommit commit;

    std::thread poster([&]() {
      for (int i = 0; i < posts; i++) {
        commit.post(worker, [&last, &runs, i]() {
          last = i;
          runs++;
        });
      }
    });

    poster.join();
  } // runs what is left

  EXPECT_EQ(last.load(), posts - 1) << "the last request was dropped";
  EXPECT_GE(runs.load(), 1);
  EXPECT_LE(runs.load(), posts);
}

TEST(CoalescedCommit, SeveralThreadsPostingAtOnceNeverLoseTheFinalRequest) {
  std::atomic<int> runs{0};
  std::atomic<int> sentinelRan{0};

  {
    CommitWorker worker;
    CoalescedCommit commit;
    std::vector<std::thread> posters;

    for (int t = 0; t < 4; t++) {
      posters.emplace_back([&]() {
        for (int i = 0; i < 2000; i++) {
          commit.post(worker, [&runs]() { runs++; });
        }
      });
    }

    for (auto& poster : posters) {
      poster.join();
    }

    // every poster is done: this request is the newest of all, and must run
    commit.post(worker, [&]() { sentinelRan++; });
  }

  EXPECT_EQ(sentinelRan.load(), 1);
  EXPECT_LE(runs.load(), 8000);
}

TEST(CoalescedCommit, AFailedPostDoesNotLeaveItWaitingForever) {
  std::atomic<int> attempts{0};
  Log runs;

  {
    CommitWorker::Options options;
    options.spawn = [&](CommitWorker::Job body) -> std::thread {
      if (attempts++ == 0) {
        throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again));
      }

      return std::thread(std::move(body));
    };

    CommitWorker worker(std::move(options));
    CoalescedCommit commit;

    EXPECT_THROW(commit.post(worker, [&]() { runs.add(1); }), std::system_error);

    // had the failed post left `waiting` set, this would be dropped and nothing would ever commit again
    EXPECT_TRUE(commit.post(worker, [&]() { runs.add(2); }));
  }

  EXPECT_EQ(runs.values(), (std::vector<int>{2}));
}

TEST(CoalescedCommit, TheRunStillWorksAfterTheOwnerIsGone) {
  Gate release;
  std::atomic<bool> busy{false};
  std::atomic<int> ran{0};

  {
    CommitWorker worker;

    worker.post([&]() {
      busy = true;
      release.wait();
    });

    ASSERT_TRUE(eventually([&]() { return busy.load(); }));

    {
      CoalescedCommit commit; // a HybridShadewind instance, collected while its commit is still queued
      commit.post(worker, [&]() { ran++; });
    }

    release.open();
  }

  EXPECT_EQ(ran.load(), 1);
}

TEST(CoalescedCommit, TwoOwnersDoNotShareTheirWaitingRun) {
  Gate release;
  std::atomic<bool> busy{false};
  Log runs;

  {
    CommitWorker worker;
    CoalescedCommit first;
    CoalescedCommit second;

    worker.post([&]() {
      busy = true;
      release.wait();
    });

    ASSERT_TRUE(eventually([&]() { return busy.load(); }));

    EXPECT_TRUE(first.post(worker, [&]() { runs.add(1); }));
    EXPECT_TRUE(second.post(worker, [&]() { runs.add(2); })); // not replaced by the other owner's request

    release.open();
  }

  EXPECT_EQ(runs.values(), (std::vector<int>{1, 2}));
}
