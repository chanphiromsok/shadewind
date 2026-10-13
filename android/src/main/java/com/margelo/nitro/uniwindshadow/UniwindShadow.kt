package com.margelo.nitro.uniwindshadow
  
import com.facebook.proguard.annotations.DoNotStrip

@DoNotStrip
class UniwindShadow : HybridUniwindShadowSpec() {
  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }
}
