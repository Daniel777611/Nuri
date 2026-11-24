#import <UIKit/UIKit.h>

/** Only a resolved React TextInput host and its UIKit descendants are visited.
 * No global keyboard observers, swizzling, private APIs or captured user text. */
NS_INLINE BOOL NuriConfigureTextInputView(UIView *host, BOOL custom) {
  if ([host isKindOfClass:[UITextField class]]) {
    UITextField *field = (UITextField *)host;
    field.inputView = custom ? [[UIView alloc] initWithFrame:CGRectZero] : nil;
    if (field.isFirstResponder) [field reloadInputViews];
    return YES;
  }
  if ([host isKindOfClass:[UITextView class]]) {
    UITextView *field = (UITextView *)host;
    field.inputView = custom ? [[UIView alloc] initWithFrame:CGRectZero] : nil;
    if (field.isFirstResponder) [field reloadInputViews];
    return YES;
  }
  for (UIView *child in host.subviews) {
    if (NuriConfigureTextInputView(child, custom)) return YES;
  }
  return NO;
}
