#import <React/RCTBridgeModule.h>
#import <React/UIView+React.h>
#import "NuriKeyboardInputPolicy.h"

@protocol NuriFabricInputHost <NSObject>
@property(nonatomic, readonly) NSString *nativeId;
@end

@interface NuriKeyboardBridge : NSObject <RCTBridgeModule>
@end

@implementation NuriKeyboardBridge
RCT_EXPORT_MODULE()
@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

RCT_EXPORT_METHOD(configure:(nonnull NSNumber *)reactTag
                  nativeID:(NSString *)nativeID
                  custom:(BOOL)custom) {
  // Use RN0.81's injected view registry, including bridgeless Fabric. The
  // public UIKit inputView/reloadInputViews APIs are
  // reapplied even if Fabric's unchanged prop diff skipped its own setter.
  UIView *host = [self.viewRegistry_DEPRECATED viewForReactTag:reactTag];
  NSString *actualID = [host respondsToSelector:@selector(nativeId)]
    ? ((id<NuriFabricInputHost>)host).nativeId : host.nativeID;
  if (!host || !nativeID.length || ![actualID isEqualToString:nativeID]) return;
  NuriConfigureTextInputView(host, custom);
}
@end
