import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Firebase is only needed for push. Without app/google-services.json the app
// still builds and runs — the web app, voice input and images all work — and
// simply never registers for notifications. See README.md.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

// Release signing is read from android/keystore.properties, which is never
// committed. Without it only the debug APK can be built.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// The site the shell loads. Override for a preview deploy with
// ./gradlew assembleDebug -PnuriOrigin=https://example.vercel.app
val webOrigin = (project.findProperty("nuriOrigin") as String?) ?: "https://nurifam.app"

// NURI's Google *web* OAuth client: Credential Manager issues the ID token to
// it, and the backend's GOOGLE_CLIENT_IDS already accepts it. Public, not a
// secret. An Android OAuth client (package + signing SHA-1) must also exist in
// the same Google Cloud project, or Google refuses the request.
val googleWebClientId = (project.findProperty("googleWebClientId") as String?)
    ?: "22059260132-e9njjaftvdn0farumni9b67p6l17nfgt.apps.googleusercontent.com"

android {
    namespace = "com.ordashtech.nuri"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ordashtech.nuri"
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        // The web page shows "Continue with Google" from NuriAndroid/0.2.0 on.
        versionName = "0.2.0"
        buildConfigField("String", "WEB_ORIGIN", "\"$webOrigin\"")
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"$googleWebClientId\"")
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // Firebase pulls in Fragment 1.1, whose result handling breaks the
    // permission and file-picker callbacks registered in MainActivity.
    implementation("androidx.fragment:fragment-ktx:1.8.5")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    // Sign in with Google through the system account sheet (GoogleSignIn.kt).
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
}
