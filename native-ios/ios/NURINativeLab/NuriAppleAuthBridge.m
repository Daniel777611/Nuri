#import <AuthenticationServices/AuthenticationServices.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(NuriAppleAuthBridge, NSObject)
RCT_EXTERN_METHOD(authorize:(NSString *)nonce
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end

@interface NuriAppleSignInView : UIView
@property (nonatomic, copy) RCTDirectEventBlock onPress;
@property (nonatomic, assign, getter=isDisabled) BOOL disabled;
@end

@implementation NuriAppleSignInView {
  ASAuthorizationAppleIDButton *_button;
}

- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    _button = [[ASAuthorizationAppleIDButton alloc] initWithAuthorizationButtonType:ASAuthorizationAppleIDButtonTypeContinue
                                                           authorizationButtonStyle:ASAuthorizationAppleIDButtonStyleBlack];
    _button.cornerRadius = 24;
    [_button addTarget:self action:@selector(pressed) forControlEvents:UIControlEventTouchUpInside];
    [self addSubview:_button];
  }
  return self;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  _button.frame = self.bounds;
}

- (void)setDisabled:(BOOL)disabled {
  _disabled = disabled;
  _button.enabled = !disabled;
  _button.alpha = disabled ? 0.55 : 1;
}

- (void)pressed {
  if (!self.isDisabled && self.onPress) self.onPress(@{});
}
@end

@interface NuriAppleSignInControlManager : RCTViewManager
@end

@implementation NuriAppleSignInControlManager
RCT_EXPORT_MODULE(NuriAppleSignInControl)
+ (BOOL)requiresMainQueueSetup { return YES; }
RCT_EXPORT_VIEW_PROPERTY(onPress, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(disabled, BOOL)

- (UIView *)view {
  return [[NuriAppleSignInView alloc] initWithFrame:CGRectZero];
}
@end
