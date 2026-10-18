require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "Shadewind"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/chanphiromsok/shadewind.git", :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{swift}",
    "ios/**/*.{m,mm}",
    "cpp/**/*.{hpp,cpp}",
  ]
  # the native test harness (gtest, folly json) and experiments are not part of the app
  s.exclude_files = ["cpp/harness/**/*", "cpp/tests/**/*", "cpp/experiments/**/*"]

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'

  # Debug builds only: the diagnostics recorder (cpp/Diagnostics.hpp) and the dev tools, i.e. inspect, setTheme timings, the
  # main-thread busy probe (cpp/DevTools.hpp). A release build that is used to measure opts in to the dev tools with
  # SHADEWIND_DEV_TOOLS=1 in the environment of `pod install`. Set before the helpers below, which merge their settings into this hash.
  xcconfig = {
    "GCC_PREPROCESSOR_DEFINITIONS[config=Debug]" => "$(inherited) SHADEWIND_DIAGNOSTICS=1 SHADEWIND_DEV_TOOLS=1",
  }
  xcconfig["GCC_PREPROCESSOR_DEFINITIONS"] = "$(inherited) SHADEWIND_DEV_TOOLS=1" if ENV["SHADEWIND_DEV_TOOLS"] == "1"
  s.pod_target_xcconfig = xcconfig

  load 'nitrogen/generated/ios/Shadewind+autolinking.rb'
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
