# The page calls into this object by name through addJavascriptInterface.
-keepclassmembers class com.ordashtech.nuri.ShellBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Credential Manager finds its Play services provider by reflection.
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** { *; }
