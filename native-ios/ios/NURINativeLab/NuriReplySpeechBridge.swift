import AVFoundation
import React
import UIKit

@objc(NuriReplySpeechBridge)
final class NuriReplySpeechBridge: NSObject, AVAudioPlayerDelegate {
  private var player: AVAudioPlayer?
  private var completion: RCTPromiseResolveBlock?
  private var previousCategory: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

  override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self, selector: #selector(stopPlayback),
      name: UIApplication.didEnterBackgroundNotification, object: nil
    )
  }

  @objc static func requiresMainQueueSetup() -> Bool { true }

  @objc(play:resolver:rejecter:)
  func play(_ base64Audio: String, resolve: @escaping RCTPromiseResolveBlock,
            reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard Bundle.main.bundleIdentifier == "com.ordashtech.nuri.beta",
            base64Audio.count <= 3_600_000,
            let audio = Data(base64Encoded: base64Audio),
            audio.count > 44
      else {
        reject("invalid_reply_audio", "This reply cannot be played.", nil)
        return
      }
      self.stopPlayback()
      do {
        let player = try AVAudioPlayer(data: audio, fileTypeHint: AVFileType.wav.rawValue)
        player.delegate = self
        let session = AVAudioSession.sharedInstance()
        self.previousCategory = (session.category, session.mode, session.categoryOptions)
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        self.player = player
        self.completion = resolve
        if !player.play() {
          self.completion = nil
          self.stopPlayback()
          reject("reply_audio_playback", "This reply cannot be played.", nil)
        }
      } catch {
        self.stopPlayback()
        reject("reply_audio_playback", "This reply cannot be played.", nil)
      }
    }
  }

  @objc func stop() {
    DispatchQueue.main.async { self.stopPlayback() }
  }

  @objc private func stopPlayback() { finish(played: false) }

  private func finish(played: Bool) {
    player?.stop()
    player = nil
    let resolve = completion
    completion = nil
    if let (category, mode, options) = previousCategory {
      previousCategory = nil
      let session = AVAudioSession.sharedInstance()
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      try? session.setCategory(category, mode: mode, options: options)
    }
    resolve?(played)
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    DispatchQueue.main.async { if self.player === player { self.finish(played: flag) } }
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    DispatchQueue.main.async { if self.player === player { self.finish(played: false) } }
  }
}
