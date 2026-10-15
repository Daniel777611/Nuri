#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(NuriGoogleAuthBridge, NSObject)
RCT_EXTERN_METHOD(getConfiguration:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
