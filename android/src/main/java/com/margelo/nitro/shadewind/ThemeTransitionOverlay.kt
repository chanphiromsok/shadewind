package com.margelo.nitro.shadewind

import android.graphics.Bitmap
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.provider.Settings
import android.util.Log
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules

/**
 * Animated theme change: a snapshot of the window is laid over the app, the engine switches the theme underneath it, and the
 * snapshot fades out once the new theme is mounted. Called from C++ (cpp/ShadewindNative.cpp, cpp/ThemeTransition.hpp), from any
 * thread; everything here runs on the UI thread.
 *
 * The snapshot is `decorView.draw(canvas)` into a Bitmap: synchronous on the UI thread, so it shows the view state at that moment
 * (the old theme). PixelCopy would also capture SurfaceView / TextureView content, but it reads the last frame the compositor
 * has, which can already be the new theme: SurfaceView content (maps, video) is not captured and shows through the overlay.
 */
@DoNotStrip
object ThemeTransitionOverlay {
  private const val TAG = "Shadewind"

  // keep in step with ThemeTransitionPreset in cpp/ShadewindNative.hpp
  private const val PRESET_FADE = 0
  private const val PRESET_BLUR = 1

  private const val BLUR_RADIUS_DP = 20f

  // If the mount never reports (nothing visible changed, so Fabric mounts nothing), do not leave a frozen picture on top.
  private const val FAILSAFE_MS = 1000L

  private val main = Handler(Looper.getMainLooper())

  // UI thread only
  private var overlay: ImageView? = null
  private var overlayId = 0L
  private var overlayMs = 0L
  private var overlayPreset = PRESET_FADE
  private var overlayAnimator: ValueAnimator? = null // the 'blur' preset; 'fade' uses the view's own property animator
  private var fading = false

  // The newest transition whose mount was reported. The mount notification is posted at the front of the queue, so it can
  // overtake the snapshot message of the same transition: that snapshot would show the new theme and sit on top, so it is skipped.
  private var mountedId = 0L

  @JvmStatic
  @DoNotStrip
  fun begin(id: Long, preset: Int, durationMs: Double) {
    // An asynchronous message passes a sync barrier, like the Choreographer frame callback that mounts React Native's views, so
    // this runs ahead of that mount whenever the frame callback has not started yet. (A plain post would wait behind the barrier,
    // i.e. behind the traversal that follows the mount.) Ordered by time with the other begin calls.
    val message = Message.obtain(main) { snapshot(id, preset, durationMs.toLong()) }

    message.isAsynchronous = true
    main.sendMessage(message)
  }

  @JvmStatic
  @DoNotStrip
  fun run(id: Long) {
    // Android pulls the transaction on the committing thread, so when the mount notification runs the C++ side may already hold the
    // theme's tree while the UI thread has not executed its mount items yet (a notification of an earlier batch can report it).
    // FabricUIManager executes mount items from a callback it re-posts every frame (DispatchUIFrameCallback), always posted before
    // this one, so a frame callback posted here runs after the items of the next frame and before that frame is drawn.
    val defer = Runnable { Choreographer.getInstance().postFrameCallback { fadeOut(id) } }

    if (Looper.myLooper() == Looper.getMainLooper()) {
      defer.run()
    } else {
      main.post(defer)
    }
  }

  private fun snapshot(id: Long, preset: Int, durationMs: Long) {
    val previous = overlay

    if (mountedId >= id) {
      remove(previous) // the screen already shows this theme

      return
    }

    try {
      val activity = NitroModules.applicationContext?.currentActivity
      val decor = activity?.window?.decorView

      if ((preset != PRESET_FADE && preset != PRESET_BLUR) ||
        activity == null ||
        decor == null ||
        activity.isFinishing ||
        activity.isDestroyed ||
        !decor.isShown ||
        decor.windowVisibility != View.VISIBLE ||
        decor.width <= 0 ||
        decor.height <= 0 ||
        animationsDisabled(activity)
      ) {
        remove(previous)

        return
      }

      val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)

      decor.draw(Canvas(bitmap))

      val view =
        ImageView(activity).apply {
          setImageBitmap(bitmap)
          scaleType = ImageView.ScaleType.FIT_XY
          isClickable = false // touches fall through to the app underneath
          isFocusable = false
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }

      (decor as ViewGroup).addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

      // the new snapshot already contains what is left of the previous overlay: only now is it safe to take that away
      remove(previous)

      overlay = view
      overlayId = id
      overlayMs = durationMs
      overlayPreset = preset
      fading = false

      main.postDelayed({ if (overlay === view) fade(view) }, FAILSAFE_MS)
    } catch (error: Throwable) {
      // OutOfMemoryError on a large screen included: the switch itself must not fail because the picture could not be taken
      Log.w(TAG, "theme transition skipped", error)
      remove(previous)
    }
  }

  private fun animationsDisabled(activity: android.app.Activity): Boolean {
    return Settings.Global.getFloat(activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
  }

  private fun fadeOut(id: Long) {
    mountedId = maxOf(mountedId, id)

    val view = overlay ?: return

    if (overlayId == id) {
      fade(view)
    }
  }

  private fun fade(view: ImageView) {
    if (overlay !== view || fading) {
      return
    }

    fading = true

    if (overlayPreset == PRESET_BLUR && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      blurOut(view)

      return
    }

    // 'fade', and 'blur' below Android 12 (no RenderEffect): a plain fade
    view
      .animate()
      .alpha(0f)
      .setDuration(overlayMs)
      .setInterpolator(LinearInterpolator())
      .withEndAction { remove(view) } // not run when the animation is cancelled: remove() is what cancels it
      .start()
  }

  // The old screen blurs for the first half of the time, then fades out (still blurred) over the second half.
  private fun blurOut(view: ImageView) {
    val maxRadius = BLUR_RADIUS_DP * view.resources.displayMetrics.density
    val animator = ValueAnimator.ofFloat(0f, 1f)

    animator.duration = overlayMs
    animator.interpolator = LinearInterpolator()
    animator.addUpdateListener {
      val progress = it.animatedValue as Float
      val radius = maxRadius * minOf(1f, progress * 2f)

      view.setRenderEffect(if (radius > 0.5f) RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP) else null)
      view.alpha = 1f - maxOf(0f, progress * 2f - 1f)
    }
    animator.addListener(
      object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          remove(view) // also called when cancelled: remove() is idempotent
        }
      }
    )

    overlayAnimator = animator
    animator.start()
  }

  // By identity: a stale end action or timer can never remove a newer overlay.
  private fun remove(view: ImageView?) {
    if (view == null) {
      return
    }

    view.animate().cancel()

    if (overlay === view) {
      val animator = overlayAnimator

      overlayAnimator = null // before cancel(): its end listener calls remove() again
      animator?.cancel()
    }

    (view.parent as? ViewGroup)?.removeView(view)
    view.setImageDrawable(null)

    if (overlay === view) {
      overlay = null
      overlayId = 0
      fading = false
    }
  }
}
