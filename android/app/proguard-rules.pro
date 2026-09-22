# The page calls into this object by name through addJavascriptInterface.
-keepclassmembers class com.ordashtech.nuri.ShellBridge {
    @android.webkit.JavascriptInterface <methods>;
}
