#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <signal.h>
#include <unistd.h>
#include <initializer_list>
#include <cmath>

// macOS has no public API for creating an offscreen rendering display.
// Resolve the optional CoreGraphics classes at runtime; never install a driver
// or change a physical display's mode. The parent verifies the resulting mode
// and the real captured pixels before using it. Failure leaves the ordinary
// capture path available, with its explicit resolution warning.
static id renderDisplay;
static unsigned renderID;
static BOOL stopping = NO;
static NSMutableData* inputBuffer;

// Declare only the runtime selectors, preserving ARC's initializer ownership.
// No private class is linked into the executable.
@interface NSObject (PdmSurfaceRuntime)
- (instancetype)initWithDescriptor:(id)descriptor;
- (instancetype)initWithWidth:(unsigned)width height:(unsigned)height refreshRate:(double)frequency;
- (BOOL)applySettings:(id)settings;
@end

static void emit(NSDictionary* value) {
  NSData* data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}

static void stopDisplay() {
  if (stopping) return;
  stopping = YES;
  renderDisplay = nil;
  exit(0);
}

static void configure(unsigned width, unsigned height) {
  @try {
    if (width < 256 || height < 256 || width > 16384 || height > 16384 ||
        (uint64_t)width * height > 80000000) {
      emit(@{@"error":@"Разрешение превышает возможности внутренней поверхности PDM."}); return;
    }
    id settings = [[NSClassFromString(@"CGVirtualDisplaySettings") alloc] init];
    id mode = [[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:width height:height refreshRate:60];
    if (!settings || !mode || ![renderDisplay respondsToSelector:NSSelectorFromString(@"applySettings:")]) {
      emit(@{@"error":@"Внутренняя поверхность недоступна в этой версии macOS."}); return;
    }
    [settings setValue:@[mode] forKey:@"modes"];
    [settings setValue:@0 forKey:@"hiDPI"];
    BOOL ok = [renderDisplay applySettings:settings];
    if (!ok) { emit(@{@"error":@"macOS не приняла разрешение внутренней поверхности."}); return; }
    // The parent applies and verifies desktop placement through its AppKit
    // connection; a standalone helper can retain stale geometry coordinates.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 350 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      if (stopping) return;
      emit(@{@"id":@(renderID), @"width":@(width), @"height":@(height)});
    });
  } @catch (NSException* exception) {
    emit(@{@"error":@"Внутренняя поверхность не поддерживается этой версией macOS."});
  }
}

int main(int argc, char** argv) { @autoreleasepool {
  if (argc != 3) return 2;
  unsigned width = (unsigned)strtoul(argv[1], nullptr, 10), height = (unsigned)strtoul(argv[2], nullptr, 10);
  if (width < 256 || height < 256 || width > 16384 || height > 16384 || (uint64_t)width * height > 80000000) {
    emit(@{@"error":@"Разрешение превышает возможности внутренней поверхности PDM."}); return 1;
  }
  @try {
    Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
    Class displayClass = NSClassFromString(@"CGVirtualDisplay");
    if (!descriptorClass || !displayClass || !NSClassFromString(@"CGVirtualDisplayMode") || !NSClassFromString(@"CGVirtualDisplaySettings")) {
      emit(@{@"error":@"В этой macOS недоступна внутренняя поверхность PDM."}); return 1;
    }
    id descriptor = [[descriptorClass alloc] init];
    [descriptor setValue:@"PDM Internal Render Surface" forKey:@"name"];
    [descriptor setValue:@(0x5044) forKey:@"vendorID"];
    [descriptor setValue:@(0x4d52) forKey:@"productID"];
    [descriptor setValue:@(getpid()) forKey:@"serialNum"];
    if ([descriptor respondsToSelector:NSSelectorFromString(@"setSerialNumber:")]) {
      [descriptor setValue:@(getpid()) forKey:@"serialNumber"];
    }
    [descriptor setValue:@16384 forKey:@"maxPixelsWide"];
    [descriptor setValue:@16384 forKey:@"maxPixelsHigh"];
    [descriptor setValue:[NSValue valueWithSize:NSMakeSize(width * 25.4 / 110, height * 25.4 / 110)] forKey:@"sizeInMillimeters"];
    [descriptor setValue:dispatch_get_main_queue() forKey:@"queue"];
    [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.64,0.33)] forKey:@"redPrimary"];
    [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.30,0.60)] forKey:@"greenPrimary"];
    [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.15,0.06)] forKey:@"bluePrimary"];
    [descriptor setValue:[NSValue valueWithPoint:NSMakePoint(0.3127,0.3290)] forKey:@"whitePoint"];
    renderDisplay = [[displayClass alloc] initWithDescriptor:descriptor];
    if (!renderDisplay) { emit(@{@"error":@"macOS не создала внутреннюю поверхность PDM."}); return 1; }
    renderID = [[renderDisplay valueForKey:@"displayID"] unsignedIntValue];
  } @catch (NSException* exception) {
    emit(@{@"error":@"Внутренняя поверхность PDM несовместима с этой macOS."}); return 1;
  }
  configure(width, height);
  inputBuffer = [NSMutableData data];
  NSFileHandle* input = [NSFileHandle fileHandleWithStandardInput];
  input.readabilityHandler = ^(NSFileHandle* input) {
    NSData* chunk = input.availableData;
    if (!chunk.length) input.readabilityHandler = nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!chunk.length) { stopDisplay(); return; }
      [inputBuffer appendData:chunk];
      if (inputBuffer.length > 4096) { stopDisplay(); return; }
      while (true) {
        const unsigned char* bytes = (const unsigned char*)inputBuffer.bytes;
        NSUInteger end = 0; while (end < inputBuffer.length && bytes[end] != '\n') end++;
        if (end == inputBuffer.length) break;
        NSData* line = [inputBuffer subdataWithRange:NSMakeRange(0,end)];
        [inputBuffer replaceBytesInRange:NSMakeRange(0,end+1) withBytes:nullptr length:0];
        id command = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if (![command isKindOfClass:NSDictionary.class]) { stopDisplay(); return; }
        configure([command[@"width"] unsignedIntValue], [command[@"height"] unsignedIntValue]);
      }
    });
  };
  NSMutableArray* signals = [NSMutableArray array];
  for (int number : {SIGTERM, SIGINT, SIGHUP}) {
    signal(number, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, number, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{ stopDisplay(); }); dispatch_resume(source); [signals addObject:source];
  }
  [[NSRunLoop currentRunLoop] run];
  return 0;
}}
