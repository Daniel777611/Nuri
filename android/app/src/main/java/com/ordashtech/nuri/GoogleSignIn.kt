package com.ordashtech.nuri

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/**
 * "Continue with Google" for the shell.
 *
 * Google refuses to sign anyone in inside a WebView (403 disallowed_useragent),
 * so the page asks the shell (`nuri:google-sign-in`) and the shell shows the
 * system's own Google account sheet through Credential Manager. The ID token
 * it returns is issued to NURI's *web* client (GOOGLE_WEB_CLIENT_ID), which is
 * exactly what POST /api/auth/google already verifies — the page hands it on
 * unchanged, and the backend needs nothing new.
 *
 * Google only serves this app once an Android OAuth client with this package
 * name and the signing key's SHA-1 exists in the same Google Cloud project.
 */
object GoogleSignIn {

    sealed interface Result {
        data class Token(val idToken: String) : Result
        /** The parent closed the sheet: say nothing. */
        data object Cancelled : Result
        /** No Google account on the phone, or Play services couldn't help. */
        data class Failed(val reason: String) : Result
    }

    suspend fun request(activity: Activity): Result {
        if (BuildConfig.GOOGLE_WEB_CLIENT_ID.isBlank()) return Result.Failed("not_configured")
        // The button flow (not the bottom-sheet "one tap" flow): it also offers
        // to add an account when the phone has none, and it is what the parent
        // just asked for by tapping the button.
        val option = GetSignInWithGoogleOption.Builder(BuildConfig.GOOGLE_WEB_CLIENT_ID).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        return try {
            val credential = CredentialManager.create(activity).getCredential(activity, request).credential
            if (credential is CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
                Result.Token(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } else {
                Result.Failed("unexpected_credential")
            }
        } catch (_: GetCredentialCancellationException) {
            Result.Cancelled
        } catch (_: NoCredentialException) {
            Result.Failed("no_account")
        } catch (e: GetCredentialException) {
            Result.Failed(e.type.substringAfterLast('.').take(60))
        } catch (e: Exception) {
            Result.Failed(e.javaClass.simpleName.take(60))
        }
    }
}
