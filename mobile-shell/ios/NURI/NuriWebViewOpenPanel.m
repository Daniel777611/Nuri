#import <AVFoundation/AVFoundation.h>
#import <ImageIO/ImageIO.h>
#import <Photos/Photos.h>
#import <PhotosUI/PhotosUI.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

#import <react-native-webview/RNCWebViewImpl.h>

typedef void (^NuriOpenPanelCompletion)(NSArray<NSURL *> * _Nullable URLs);

static const void *NuriOpenPanelCoordinatorKey = &NuriOpenPanelCoordinatorKey;
static const NSInteger NuriUploadMaxPixelSize = 1600;
static const CGFloat NuriUploadJPEGQuality = 0.72;

static NSError *NuriImageError(NSString *description) {
  return [NSError errorWithDomain:@"com.ordashtech.nuri.image"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey: description}];
}

static NSURL * _Nullable NuriUploadsDirectory(NSError **error) {
  NSURL *caches = [[NSFileManager defaultManager]
      URLForDirectory:NSCachesDirectory
             inDomain:NSUserDomainMask
    appropriateForURL:nil
               create:YES
                error:error];
  if (caches == nil) {
    return nil;
  }

  NSURL *directory = [caches URLByAppendingPathComponent:@"NuriUploads" isDirectory:YES];
  if (![[NSFileManager defaultManager] createDirectoryAtURL:directory
                                withIntermediateDirectories:YES
                                                 attributes:nil
                                                      error:error]) {
    return nil;
  }
  return directory;
}

static NSURL * _Nullable NuriNewUploadURL(NSError **error) {
  NSURL *directory = NuriUploadsDirectory(error);
  if (directory == nil) {
    return nil;
  }
  NSString *filename = [[[NSUUID UUID] UUIDString] stringByAppendingPathExtension:@"jpg"];
  return [directory URLByAppendingPathComponent:filename isDirectory:NO];
}

static void NuriExcludeFromBackup(NSURL *url) {
  [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}

static NSURL * _Nullable NuriDownsampleImageAtURL(NSURL *sourceURL, NSError **error) {
  NSDictionary *sourceOptions = @{(__bridge NSString *)kCGImageSourceShouldCache: @NO};
  CGImageSourceRef source = CGImageSourceCreateWithURL(
      (__bridge CFURLRef)sourceURL,
      (__bridge CFDictionaryRef)sourceOptions);
  if (source == nil) {
    if (error != NULL) {
      *error = NuriImageError(@"无法读取所选图片");
    }
    return nil;
  }

  NSDictionary *thumbnailOptions = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @(NuriUploadMaxPixelSize),
    (__bridge NSString *)kCGImageSourceShouldCacheImmediately: @NO,
  };
  CGImageRef thumbnail = CGImageSourceCreateThumbnailAtIndex(
      source,
      0,
      (__bridge CFDictionaryRef)thumbnailOptions);
  CFRelease(source);

  if (thumbnail == nil) {
    if (error != NULL) {
      *error = NuriImageError(@"无法生成安全尺寸的图片");
    }
    return nil;
  }

  NSURL *destinationURL = NuriNewUploadURL(error);
  if (destinationURL == nil) {
    CGImageRelease(thumbnail);
    return nil;
  }

  CGImageDestinationRef destination = CGImageDestinationCreateWithURL(
      (__bridge CFURLRef)destinationURL,
      (__bridge CFStringRef)UTTypeJPEG.identifier,
      1,
      nil);
  if (destination == nil) {
    CGImageRelease(thumbnail);
    if (error != NULL) {
      *error = NuriImageError(@"无法创建图片上传文件");
    }
    return nil;
  }

  NSDictionary *properties = @{
    (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(NuriUploadJPEGQuality),
  };
  CGImageDestinationAddImage(
      destination,
      thumbnail,
      (__bridge CFDictionaryRef)properties);
  BOOL wroteImage = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  CGImageRelease(thumbnail);

  if (!wroteImage) {
    [[NSFileManager defaultManager] removeItemAtURL:destinationURL error:nil];
    if (error != NULL) {
      *error = NuriImageError(@"无法写入图片上传文件");
    }
    return nil;
  }

  NuriExcludeFromBackup(destinationURL);
  return destinationURL;
}

static NSURL * _Nullable NuriUploadFileFromCameraImage(UIImage *image, NSError **error) {
  CGFloat pixelWidth = image.size.width * image.scale;
  CGFloat pixelHeight = image.size.height * image.scale;
  CGFloat longestSide = MAX(pixelWidth, pixelHeight);
  CGFloat ratio = longestSide > NuriUploadMaxPixelSize
      ? NuriUploadMaxPixelSize / longestSide
      : 1.0;
  CGSize outputSize = CGSizeMake(
      MAX(1.0, floor(pixelWidth * ratio)),
      MAX(1.0, floor(pixelHeight * ratio)));

  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
  format.scale = 1.0;
  format.opaque = YES;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc]
      initWithSize:outputSize
            format:format];
  UIImage *scaledImage = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    [[UIColor whiteColor] setFill];
    UIRectFill(CGRectMake(0, 0, outputSize.width, outputSize.height));
    [image drawInRect:CGRectMake(0, 0, outputSize.width, outputSize.height)];
  }];

  NSData *jpeg = UIImageJPEGRepresentation(scaledImage, NuriUploadJPEGQuality);
  if (jpeg == nil) {
    if (error != NULL) {
      *error = NuriImageError(@"无法转换相机图片");
    }
    return nil;
  }

  NSURL *destinationURL = NuriNewUploadURL(error);
  if (destinationURL == nil || ![jpeg writeToURL:destinationURL
                                      options:NSDataWritingAtomic
                                        error:error]) {
    return nil;
  }
  NuriExcludeFromBackup(destinationURL);
  return destinationURL;
}

static UIViewController * _Nullable NuriTopViewController(UIViewController * _Nullable controller) {
  if (controller == nil) {
    return nil;
  }
  if (controller.presentedViewController != nil && !controller.presentedViewController.isBeingDismissed) {
    return NuriTopViewController(controller.presentedViewController);
  }
  if ([controller isKindOfClass:[UINavigationController class]]) {
    return NuriTopViewController(((UINavigationController *)controller).visibleViewController);
  }
  if ([controller isKindOfClass:[UITabBarController class]]) {
    return NuriTopViewController(((UITabBarController *)controller).selectedViewController);
  }
  return controller;
}

typedef NS_ENUM(NSInteger, NuriImageSource) {
  NuriImageSourceCancel = 0,
  NuriImageSourceCamera,
  NuriImageSourcePhotos,
  NuriImageSourceFiles,
};

typedef void (^NuriImageSourceSelectionHandler)(NuriImageSource source);

@interface NuriImageSourceSheetController : UITableViewController
    <UIAdaptivePresentationControllerDelegate>

@property(nonatomic, copy, nullable) NuriImageSourceSelectionHandler selectionHandler;
@property(nonatomic, copy) NSArray<NSNumber *> *sources;

- (instancetype)initWithCameraAvailable:(BOOL)cameraAvailable
                        selectionHandler:(NuriImageSourceSelectionHandler)selectionHandler;

@end

@implementation NuriImageSourceSheetController

- (instancetype)initWithCameraAvailable:(BOOL)cameraAvailable
                        selectionHandler:(NuriImageSourceSelectionHandler)selectionHandler {
  self = [super initWithStyle:UITableViewStyleInsetGrouped];
  if (self) {
    NSMutableArray<NSNumber *> *sources = [NSMutableArray array];
    if (cameraAvailable) {
      [sources addObject:@(NuriImageSourceCamera)];
    }
    [sources addObject:@(NuriImageSourcePhotos)];
    [sources addObject:@(NuriImageSourceFiles)];
    _sources = [sources copy];
    _selectionHandler = [selectionHandler copy];
  }
  return self;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = @"添加图片";
  self.navigationItem.largeTitleDisplayMode = UINavigationItemLargeTitleDisplayModeNever;
  self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc]
      initWithBarButtonSystemItem:UIBarButtonSystemItemCancel
                           target:self
                           action:@selector(cancelSelection)];
  self.tableView.rowHeight = 70.0;
  self.tableView.scrollEnabled = NO;
  self.tableView.backgroundColor = UIColor.systemGroupedBackgroundColor;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  return self.sources.count;
}

- (UITableViewCell *)tableView:(UITableView *)tableView
         cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  static NSString *const reuseIdentifier = @"NuriImageSourceCell";
  UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:reuseIdentifier];
  if (cell == nil) {
    cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle
                                  reuseIdentifier:reuseIdentifier];
  }

  NuriImageSource source = (NuriImageSource)self.sources[indexPath.row].integerValue;
  UIListContentConfiguration *content = [UIListContentConfiguration subtitleCellConfiguration];
  content.textProperties.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  content.secondaryTextProperties.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
  content.secondaryTextProperties.color = UIColor.secondaryLabelColor;
  content.imageProperties.tintColor = UIColor.systemBlueColor;
  content.imageProperties.maximumSize = CGSizeMake(28.0, 28.0);

  switch (source) {
    case NuriImageSourceCamera:
      content.text = @"拍照";
      content.secondaryText = @"使用相机拍摄新照片";
      content.image = [UIImage systemImageNamed:@"camera.fill"];
      break;
    case NuriImageSourcePhotos:
      content.text = @"从照片中选择";
      content.secondaryText = @"打开系统照片选择器";
      content.image = [UIImage systemImageNamed:@"photo.on.rectangle.angled"];
      break;
    case NuriImageSourceFiles:
      content.text = @"浏览文件";
      content.secondaryText = @"从“文件”中选择图片";
      content.image = [UIImage systemImageNamed:@"folder.fill"];
      break;
    case NuriImageSourceCancel:
      break;
  }

  cell.contentConfiguration = content;
  cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
  cell.selectionStyle = UITableViewCellSelectionStyleDefault;
  return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  [self completeWithSource:(NuriImageSource)self.sources[indexPath.row].integerValue];
}

- (void)cancelSelection {
  [self completeWithSource:NuriImageSourceCancel];
}

- (void)completeWithSource:(NuriImageSource)source {
  NuriImageSourceSelectionHandler handler = self.selectionHandler;
  if (handler == nil) {
    return;
  }
  self.selectionHandler = nil;
  [self dismissViewControllerAnimated:YES completion:^{
    handler(source);
  }];
}

- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController {
  NuriImageSourceSelectionHandler handler = self.selectionHandler;
  self.selectionHandler = nil;
  if (handler != nil) {
    handler(NuriImageSourceCancel);
  }
}

@end

@interface NuriOpenPanelCoordinator : NSObject
    <UIImagePickerControllerDelegate,
     UINavigationControllerDelegate,
     PHPickerViewControllerDelegate,
     UIDocumentPickerDelegate>

@property(nonatomic, weak) RNCWebViewImpl *owner;
@property(nonatomic, weak) WKWebView *webView;
@property(nonatomic, copy, nullable) NuriOpenPanelCompletion completion;
@property(nonatomic, assign) BOOL allowsMultipleSelection;

- (instancetype)initWithOwner:(RNCWebViewImpl *)owner
                       webView:(WKWebView *)webView
       allowsMultipleSelection:(BOOL)allowsMultipleSelection
                    completion:(NuriOpenPanelCompletion)completion;
- (void)presentSourceChooser;
- (void)cancel;

@end

@implementation NuriOpenPanelCoordinator

- (instancetype)initWithOwner:(RNCWebViewImpl *)owner
                       webView:(WKWebView *)webView
       allowsMultipleSelection:(BOOL)allowsMultipleSelection
                    completion:(NuriOpenPanelCompletion)completion {
  self = [super init];
  if (self) {
    _owner = owner;
    _webView = webView;
    _allowsMultipleSelection = allowsMultipleSelection;
    _completion = [completion copy];
  }
  return self;
}

- (UIViewController * _Nullable)presenter {
  return NuriTopViewController(self.webView.window.rootViewController);
}

- (void)presentSourceChooser {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = [self presenter];
    if (presenter == nil || self.completion == nil) {
      [self finishWithURLs:nil];
      return;
    }

    NuriImageSourceSheetController *sheet = [[NuriImageSourceSheetController alloc]
        initWithCameraAvailable:[UIImagePickerController
                                    isSourceTypeAvailable:UIImagePickerControllerSourceTypeCamera]
              selectionHandler:^(NuriImageSource source) {
      switch (source) {
        case NuriImageSourceCamera:
          [self requestCameraAndPresent];
          break;
        case NuriImageSourcePhotos:
          [self presentPhotoPicker];
          break;
        case NuriImageSourceFiles:
          [self presentDocumentPicker];
          break;
        case NuriImageSourceCancel:
          [self finishWithURLs:nil];
          break;
      }
    }];

    UINavigationController *navigationController = [[UINavigationController alloc]
        initWithRootViewController:sheet];
    navigationController.modalPresentationStyle = UIModalPresentationPageSheet;
    navigationController.presentationController.delegate = sheet;

    UISheetPresentationController *presentation = navigationController.sheetPresentationController;
    if (presentation != nil) {
      UISheetPresentationControllerDetent *compactDetent =
          [UISheetPresentationControllerDetent
              customDetentWithIdentifier:@"com.ordashtech.nuri.image-source"
                                resolver:^CGFloat(id<UISheetPresentationControllerDetentResolutionContext> context) {
        return MIN(330.0, context.maximumDetentValue);
      }];
      presentation.detents = @[compactDetent];
      presentation.prefersGrabberVisible = YES;
      presentation.prefersScrollingExpandsWhenScrolledToEdge = NO;
    }

    [presenter presentViewController:navigationController animated:YES completion:nil];
  });
}

- (void)requestCameraAndPresent {
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if (status == AVAuthorizationStatusAuthorized) {
    [self presentCamera];
    return;
  }
  if (status == AVAuthorizationStatusNotDetermined) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        granted ? [self presentCamera] : [self showCameraPermissionError];
      });
    }];
    return;
  }
  [self showCameraPermissionError];
}

- (void)presentCamera {
  UIViewController *presenter = [self presenter];
  if (presenter == nil || ![UIImagePickerController isSourceTypeAvailable:UIImagePickerControllerSourceTypeCamera]) {
    [self showProcessingError:@"当前设备无法使用相机"];
    [self finishWithURLs:nil];
    return;
  }

  UIImagePickerController *picker = [[UIImagePickerController alloc] init];
  picker.sourceType = UIImagePickerControllerSourceTypeCamera;
  picker.mediaTypes = @[UTTypeImage.identifier];
  picker.allowsEditing = NO;
  picker.delegate = self;
  [presenter presentViewController:picker animated:YES completion:nil];
}

- (void)presentPhotoPicker {
  UIViewController *presenter = [self presenter];
  if (presenter == nil) {
    [self finishWithURLs:nil];
    return;
  }

  PHPickerConfiguration *configuration = [[PHPickerConfiguration alloc]
      initWithPhotoLibrary:[PHPhotoLibrary sharedPhotoLibrary]];
  configuration.filter = PHPickerFilter.imagesFilter;
  configuration.selectionLimit = self.allowsMultipleSelection ? 0 : 1;
  configuration.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;

  PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:configuration];
  picker.delegate = self;
  [presenter presentViewController:picker animated:YES completion:nil];
}

- (void)presentDocumentPicker {
  UIViewController *presenter = [self presenter];
  if (presenter == nil) {
    [self finishWithURLs:nil];
    return;
  }

  UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc]
      initForOpeningContentTypes:@[UTTypeImage]
                          asCopy:YES];
  picker.allowsMultipleSelection = self.allowsMultipleSelection;
  picker.delegate = self;
  [presenter presentViewController:picker animated:YES completion:nil];
}

- (void)imagePickerController:(UIImagePickerController *)picker
didFinishPickingMediaWithInfo:(NSDictionary<UIImagePickerControllerInfoKey, id> *)info {
  UIImage *image = info[UIImagePickerControllerOriginalImage];
  [picker dismissViewControllerAnimated:YES completion:^{
    if (image == nil) {
      [self showProcessingError:@"没有取得相机图片"];
      [self finishWithURLs:nil];
      return;
    }

    [self saveCapturedImageToPhotoLibrary:image];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSError *error = nil;
      NSURL *uploadURL = NuriUploadFileFromCameraImage(image, &error);
      dispatch_async(dispatch_get_main_queue(), ^{
        if (uploadURL == nil) {
          [self showProcessingError:error.localizedDescription ?: @"图片处理失败，请重试"];
          [self finishWithURLs:nil];
        } else {
          [self finishWithURLs:@[uploadURL]];
        }
      });
    });
  }];
}

- (void)imagePickerControllerDidCancel:(UIImagePickerController *)picker {
  [picker dismissViewControllerAnimated:YES completion:^{
    [self finishWithURLs:nil];
  }];
}

- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  if (results.count == 0) {
    [self finishWithURLs:nil];
    return;
  }

  NSMutableArray *providers = [NSMutableArray arrayWithCapacity:results.count];
  for (PHPickerResult *result in results) {
    if ([result.itemProvider hasItemConformingToTypeIdentifier:UTTypeImage.identifier]) {
      [providers addObject:result.itemProvider];
    }
  }
  [self processItemProviders:providers];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  if (urls.count == 0) {
    [self finishWithURLs:nil];
    return;
  }
  [self processDocumentURLs:urls];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  [self finishWithURLs:nil];
}

- (void)processItemProviders:(NSArray<NSItemProvider *> *)providers {
  if (providers.count == 0) {
    [self showProcessingError:@"暂时只支持图片格式"];
    [self finishWithURLs:nil];
    return;
  }

  dispatch_group_t group = dispatch_group_create();
  NSMutableArray *prepared = [NSMutableArray arrayWithCapacity:providers.count];
  for (NSUInteger index = 0; index < providers.count; index++) {
    [prepared addObject:[NSNull null]];
  }

  [providers enumerateObjectsUsingBlock:^(NSItemProvider *provider, NSUInteger index, BOOL *stop) {
    dispatch_group_enter(group);
    [provider loadFileRepresentationForTypeIdentifier:UTTypeImage.identifier
                                    completionHandler:^(NSURL *url, NSError *providerError) {
      NSError *error = providerError;
      NSURL *uploadURL = nil;
      if (url != nil) {
        uploadURL = NuriDownsampleImageAtURL(url, &error);
      }
      if (uploadURL != nil) {
        @synchronized (prepared) {
          prepared[index] = uploadURL;
        }
      }
      dispatch_group_leave(group);
    }];
  }];

  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSMutableArray<NSURL *> *urls = [NSMutableArray array];
    for (id value in prepared) {
      if ([value isKindOfClass:[NSURL class]]) {
        [urls addObject:value];
      }
    }
    if (urls.count == 0) {
      [self showProcessingError:@"图片处理失败，请重试"];
      [self finishWithURLs:nil];
    } else {
      [self finishWithURLs:urls];
    }
  });
}

- (void)processDocumentURLs:(NSArray<NSURL *> *)sourceURLs {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSMutableArray<NSURL *> *prepared = [NSMutableArray array];
    for (NSURL *sourceURL in sourceURLs) {
      BOOL accessed = [sourceURL startAccessingSecurityScopedResource];
      NSError *error = nil;
      NSURL *uploadURL = NuriDownsampleImageAtURL(sourceURL, &error);
      if (accessed) {
        [sourceURL stopAccessingSecurityScopedResource];
      }
      if (uploadURL != nil) {
        [prepared addObject:uploadURL];
      }
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      if (prepared.count == 0) {
        [self showProcessingError:@"图片处理失败，请重试"];
        [self finishWithURLs:nil];
      } else {
        [self finishWithURLs:prepared];
      }
    });
  });
}

- (void)saveCapturedImageToPhotoLibrary:(UIImage *)image {
  [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly
                                              handler:^(PHAuthorizationStatus status) {
    if (status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [self showPhotoSaveError:@"没有相册写入权限。图片仍可发送给 AI，但不会保存到系统相册。"];
      });
      return;
    }

    [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
      [PHAssetChangeRequest creationRequestForAssetFromImage:image];
    } completionHandler:^(BOOL success, NSError *error) {
      if (!success) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [self showPhotoSaveError:@"照片未能保存到系统相册，请检查相册权限和设备存储空间。"];
        });
      }
    }];
  }];
}

- (void)showCameraPermissionError {
  [self showSettingsAlertWithTitle:@"无法使用相机"
                           message:@"请在系统设置中允许 NURI 使用相机，然后返回对话重试。"];
  [self finishWithURLs:nil];
}

- (void)showPhotoSaveError:(NSString *)message {
  [self showSettingsAlertWithTitle:@"照片未保存" message:message];
}

- (void)showSettingsAlertWithTitle:(NSString *)title message:(NSString *)message {
  UIViewController *presenter = [self presenter];
  if (presenter == nil || presenter.presentedViewController != nil) {
    return;
  }
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:title
                                                                 message:message
                                                          preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"知道了"
                                            style:UIAlertActionStyleCancel
                                          handler:nil]];
  [alert addAction:[UIAlertAction actionWithTitle:@"前往设置"
                                            style:UIAlertActionStyleDefault
                                          handler:^(__unused UIAlertAction *action) {
    NSURL *settingsURL = [NSURL URLWithString:UIApplicationOpenSettingsURLString];
    if (settingsURL != nil) {
      [[UIApplication sharedApplication] openURL:settingsURL options:@{} completionHandler:nil];
    }
  }]];
  [presenter presentViewController:alert animated:YES completion:nil];
}

- (void)showProcessingError:(NSString *)message {
  UIViewController *presenter = [self presenter];
  if (presenter == nil || presenter.presentedViewController != nil) {
    return;
  }
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"图片处理失败"
                                                                 message:message
                                                          preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"知道了"
                                            style:UIAlertActionStyleCancel
                                          handler:nil]];
  [presenter presentViewController:alert animated:YES completion:nil];
}

- (void)finishWithURLs:(NSArray<NSURL *> * _Nullable)urls {
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self finishWithURLs:urls];
    });
    return;
  }

  NuriOpenPanelCompletion completion = self.completion;
  if (completion == nil) {
    return;
  }
  self.completion = nil;
  completion(urls.count > 0 ? urls : nil);

  RNCWebViewImpl *owner = self.owner;
  if (owner != nil && objc_getAssociatedObject(owner, NuriOpenPanelCoordinatorKey) == self) {
    objc_setAssociatedObject(owner, NuriOpenPanelCoordinatorKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

- (void)cancel {
  [self finishWithURLs:nil];
}

@end

@implementation RNCWebViewImpl (NuriOpenPanel)

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
             initiatedByFrame:(WKFrameInfo *)frame
            completionHandler:(void (^)(NSArray<NSURL *> * _Nullable URLs))completionHandler
    API_AVAILABLE(ios(18.4)) {
  NuriOpenPanelCoordinator *existing = objc_getAssociatedObject(self, NuriOpenPanelCoordinatorKey);
  [existing cancel];

  NuriOpenPanelCoordinator *coordinator = [[NuriOpenPanelCoordinator alloc]
      initWithOwner:self
            webView:webView
    allowsMultipleSelection:parameters.allowsMultipleSelection
         completion:completionHandler];
  objc_setAssociatedObject(
      self,
      NuriOpenPanelCoordinatorKey,
      coordinator,
      OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [coordinator presentSourceChooser];
}

@end
