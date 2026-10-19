// Keynote 14 and Keynote 15 (Creator Studio) have different bundle IDs.
// Use the same allowlist for discovery, Apple events and AX window checks.
static NSArray<NSString *> *keynoteBundleIdentifiers() {
  return @[@"com.apple.iWork.Keynote", @"com.apple.Keynote"];
}
static BOOL keynoteBundleIdentifier(NSString *identifier) {
  return identifier && [keynoteBundleIdentifiers() containsObject:identifier];
}
static NSDictionary *keynoteApplicationInfo(NSURL *url) {
  NSBundle *bundle = url ? [NSBundle bundleWithURL:url] : nil;
  if (!keynoteBundleIdentifier(bundle.bundleIdentifier)) return nil;
  return @{@"bundleId":bundle.bundleIdentifier, @"path":url.path,
    @"version":[bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"unknown"};
}
