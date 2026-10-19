#import <AppKit/AppKit.h>
#include "mac-keynote-identity.h"

// Compile/run on macOS. Exercise the actual native identity helper used by
// both Apple-event dispatch and AX window validation, with real NSBundles.
int main(void) {
  @autoreleasepool {
    NSCAssert(keynoteBundleIdentifier(@"com.apple.iWork.Keynote"), @"Keynote 14 must remain supported");
    NSCAssert(keynoteBundleIdentifier(@"com.apple.Keynote"), @"Keynote 15 must be supported");
    NSCAssert(!keynoteBundleIdentifier(@"com.apple.Keynote.Helper"), @"Helpers must not become players");
    NSCAssert(!keynoteBundleIdentifier(@"com.example.Keynote"), @"Other apps must not become players");
    NSCAssert(!keynoteBundleIdentifier(nil), @"Missing identity must be rejected");
    NSString *root=[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    @try {
      for(NSString *identifier in @[@"com.apple.iWork.Keynote",@"com.apple.Keynote",@"com.example.Keynote"]) {
        NSString *bundlePath=[root stringByAppendingPathComponent:[identifier stringByAppendingString:@".app"]];
        NSString *contents=[bundlePath stringByAppendingPathComponent:@"Contents"];
        NSCAssert([NSFileManager.defaultManager createDirectoryAtPath:contents withIntermediateDirectories:YES attributes:nil error:nil],@"Create fixture");
        NSDictionary *metadata=@{@"CFBundleIdentifier":identifier,@"CFBundleShortVersionString":@"15.4",@"CFBundlePackageType":@"APPL"};
        NSCAssert([metadata writeToFile:[contents stringByAppendingPathComponent:@"Info.plist"] atomically:YES],@"Write fixture metadata");
        NSDictionary *info=keynoteApplicationInfo([NSURL fileURLWithPath:bundlePath]);
        if(keynoteBundleIdentifier(identifier)) {
          NSCAssert([info[@"bundleId"] isEqual:identifier] && [info[@"version"] isEqual:@"15.4"] && [info[@"path"] isEqual:bundlePath],@"Use verified bundle identity and exact path");
        } else NSCAssert(!info,@"Reject unrecognized bundle");
      }
      puts("PASS: native discovery and window identity allow Keynote 14/15; reject helpers, unrelated and missing bundles");
    } @finally { [NSFileManager.defaultManager removeItemAtPath:root error:nil]; }
  }
  return 0;
}
