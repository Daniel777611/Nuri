#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(NuriReplySpeechBridge, NSObject)

RCT_EXTERN_METHOD(play:(NSString *)base64Audio
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stop)

@end
