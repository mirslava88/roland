#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <string>
#include <vector>
#include <algorithm>
#include <cmath>
#include <limits>
#include <unistd.h>
#include <cfloat>
#include <sys/sysctl.h>
#include "mac-keynote-identity.h"

// Run on Electron's main thread. Leave the user's Dock preferences intact;
// remove only this application's fullscreen requests to hide desktop chrome.
static napi_value restoreMacDockVisibility(napi_env env, napi_callback_info) {
  @autoreleasepool {
    if (!NSThread.isMainThread) {
      napi_throw_error(env, nullptr, "Desktop UI must be configured on the main thread"); return nullptr;
    }
    @try {
      NSApplicationPresentationOptions options = NSApp.presentationOptions;
      // Let AppKit finish a native green-button Space transition. The
      // control converts it to simple fullscreen after leave-full-screen.
      if (options & NSApplicationPresentationFullScreen) {
        napi_value result; napi_get_boolean(env, true, &result); return result;
      }
      // AppKit requires menu hiding to be combined with Dock hiding. Clear
      // both together; Program covers them with its own window level.
      NSApplicationPresentationOptions visible = options & ~(NSApplicationPresentationHideDock |
        NSApplicationPresentationAutoHideDock | NSApplicationPresentationHideMenuBar |
        NSApplicationPresentationAutoHideMenuBar);
      if (options != visible) NSApp.presentationOptions = visible;
    } @catch (NSException* error) {
      napi_throw_error(env, nullptr, error.reason.UTF8String); return nullptr;
    }
    napi_value result; napi_get_boolean(env, true, &result); return result;
  }
}

// NSArgumentDomain belongs to the running Keynote process, not to the PDM
// session which launched it. Read argv from that exact PID when borrowing a
// player after restart; background menu items may have no AX check mark.
static bool keynoteHasWindowedLaunch(pid_t pid) {
  int query[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(query, 3, nullptr, &size, nullptr, 0) != 0 || size < sizeof(int)) return false;
  std::vector<char> data(size);
  if (sysctl(query, 3, data.data(), &size, nullptr, 0) != 0) return false;
  int argc = 0;
  memcpy(&argc, data.data(), sizeof(argc));
  const char* cursor = data.data() + sizeof(argc);
  const char* end = data.data() + size;
  // KERN_PROCARGS2 starts with the executable path followed by padding, then
  // argc NUL-terminated arguments. Never inspect environment variables.
  while (cursor < end && *cursor) cursor++;
  while (cursor < end && !*cursor) cursor++;
  bool enabled = false;
  std::string previous;
  for (int index = 0; index < argc && cursor < end; index++) {
    const char* start = cursor;
    while (cursor < end && *cursor) cursor++;
    if (cursor == end) return false;
    std::string current(start, cursor++);
    if (previous == "-KNMacPrefersWindowedPlayback")
      enabled = current == "YES" || current == "true" || current == "1";
    previous = current;
  }
  return enabled;
}

// Prepare only the Office window assigned a PDM-generated title.
// Running inside Electron makes the user's Accessibility grant belong to PDM,
// rather than requiring another grant for an osascript child process.
static NSString* attributeString(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) return nil;
  NSString* text = CFGetTypeID(value) == CFStringGetTypeID() ? [(__bridge NSString*)value copy] : nil;
  CFRelease(value);
  return text;
}

static bool frameOf(AXUIElementRef element, CGRect& frame) {
  CFTypeRef position = nullptr, size = nullptr;
  AXError p = AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &position);
  AXError s = AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &size);
  CGPoint point = CGPointZero;
  CGSize dimensions = CGSizeZero;
  bool valid = p == kAXErrorSuccess && s == kAXErrorSuccess && position && size &&
    CFGetTypeID(position) == AXValueGetTypeID() && CFGetTypeID(size) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)position, (AXValueType)kAXValueCGPointType, &point) &&
    AXValueGetValue((AXValueRef)size, (AXValueType)kAXValueCGSizeType, &dimensions);
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  if (valid) frame = CGRectMake(point.x, point.y, dimensions.width, dimensions.height);
  return valid && dimensions.width > 0 && dimensions.height > 0;
}

static napi_value rectangle(napi_env env, CGRect frame) {
  napi_value array;
  napi_create_array_with_length(env, 4, &array);
  double values[] = {frame.origin.x, frame.origin.y, frame.size.width, frame.size.height};
  for (uint32_t i = 0; i < 4; i++) {
    napi_value number;
    napi_create_double(env, values[i], &number);
    napi_set_element(env, array, i, number);
  }
  return array;
}

static bool argument(napi_env env, napi_value value, std::string& text) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 4096) return false;
  text.resize(length + 1);
  if (napi_get_value_string_utf8(env, value, text.data(), text.size(), &length) != napi_ok) return false;
  text.resize(length);
  return true;
}

static napi_value prepareDocumentWindow(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    std::string bundle, marker;
    if (count != 2 || !argument(env, args[0], bundle) || !argument(env, args[1], marker) ||
        (bundle != "com.microsoft.Word" && bundle != "com.microsoft.Excel") || marker.rfind("PDM ", 0) != 0) {
      napi_throw_error(env, nullptr, "Invalid Office window identifier"); return nullptr;
    }
    if (!AXIsProcessTrusted()) {
      napi_throw_error(env, nullptr, "PDM needs Accessibility permission to identify the document area"); return nullptr;
    }
    NSArray<NSRunningApplication*>* applications = [NSRunningApplication runningApplicationsWithBundleIdentifier:
      [NSString stringWithUTF8String:bundle.c_str()]];
    if (applications.count != 1) {
      napi_throw_error(env, nullptr, "Office application is unavailable or ambiguous"); return nullptr;
    }
    AXUIElementRef application = AXUIElementCreateApplication(applications[0].processIdentifier);
    AXUIElementSetMessagingTimeout(application, 2.0);
    CFTypeRef windowsValue = nullptr;
    AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windowsValue);
    CFRelease(application);
    AXUIElementRef target = nullptr;
    NSUInteger matches = 0;
    NSString* prefix = [NSString stringWithUTF8String:marker.c_str()];
    if (windowsValue && CFGetTypeID(windowsValue) == CFArrayGetTypeID()) {
      CFArrayRef windows = (CFArrayRef)windowsValue;
      for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
        AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
        if ([attributeString(window, kAXTitleAttribute) hasPrefix:prefix]) {
          target = window; matches++;
        }
      }
    }
    if (matches == 1) {
      // The script has already placed this document on the output display.
      // Restore its visibility without activating Office or switching Spaces.
      AXUIElementSetAttributeValue(target, kAXMinimizedAttribute, kCFBooleanFalse);
      [applications[0] unhide];
    }
    CGRect windowFrame = CGRectZero, contentFrame = CGRectZero;
    bool valid = matches == 1 && frameOf(target, windowFrame);
    CFTypeRef childrenValue = nullptr;
    if (valid) AXUIElementCopyAttributeValue(target, kAXChildrenAttribute, &childrenValue);
    bool foundContent = false;
    if (childrenValue && CFGetTypeID(childrenValue) == CFArrayGetTypeID()) {
      CFArrayRef children = (CFArrayRef)childrenValue;
      for (CFIndex i = 0; i < CFArrayGetCount(children); i++) {
        AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);
        if ([attributeString(child, kAXRoleAttribute) isEqualToString:(__bridge NSString*)kAXSplitGroupRole] && frameOf(child, contentFrame)) {
          foundContent = true; break;
        }
      }
    }
    if (childrenValue) CFRelease(childrenValue);
    if (windowsValue) CFRelease(windowsValue);
    if (!valid || !foundContent) {
      napi_throw_error(env, nullptr, "Office did not expose a unique document area"); return nullptr;
    }
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "windowBounds", rectangle(env, windowFrame));
    napi_set_named_property(env, result, "contentBounds", rectangle(env, contentFrame));
    return result;
  }
}

// An internal rendering screen is not an operator desktop. Filter only mouse
// events whose destination is one of PDM's own surfaces; all physical screens
// and keyboard events pass through unchanged. This lives inside PDM so it uses
// the application's existing Accessibility grant.
static CFMachPortRef renderCursorTap = nullptr;
static CFRunLoopSourceRef renderCursorSource = nullptr;
static std::vector<CGRect> renderScreens, physicalScreens;

static CGRect appDisplayBounds(CGDirectDisplayID displayID) {
  CGFloat primaryHeight = 0;
  for (NSScreen* screen in NSScreen.screens) {
    unsigned id = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
    if (id == CGMainDisplayID()) primaryHeight = screen.frame.size.height;
  }
  for (NSScreen* screen in NSScreen.screens) {
    unsigned id = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
    if (id == displayID) {
      NSRect frame = screen.frame;
      return CGRectMake(frame.origin.x, primaryHeight - NSMaxY(frame), frame.size.width, frame.size.height);
    }
  }
  return CGRectZero;
}

static void refreshRenderScreens() {
  renderScreens.clear(); physicalScreens.clear();
  CGDirectDisplayID ids[64]; uint32_t count = 0;
  if (CGGetOnlineDisplayList(64, ids, &count) != kCGErrorSuccess) return;
  for (uint32_t i = 0; i < count; i++) {
    CGRect bounds = appDisplayBounds(ids[i]);
    if (bounds.size.width <= 0 || bounds.size.height <= 0) continue;
    bool internal = CGDisplayVendorNumber(ids[i]) == 0x5044 && CGDisplayModelNumber(ids[i]) == 0x4d52;
    (internal ? renderScreens : physicalScreens).push_back(bounds);
  }
}

static CGPoint projectCursor(CGPoint point) {
  bool internal = false;
  for (CGRect bounds : renderScreens) if (CGRectContainsPoint(bounds, point)) internal = true;
  if (!internal || physicalScreens.empty()) return point;
  CGPoint best = point; double distance = std::numeric_limits<double>::infinity();
  for (CGRect bounds : physicalScreens) {
    CGPoint candidate = { std::clamp(point.x, CGRectGetMinX(bounds), CGRectGetMaxX(bounds) - 1),
      std::clamp(point.y, CGRectGetMinY(bounds), CGRectGetMaxY(bounds) - 1) };
    double d = std::hypot(candidate.x - point.x, candidate.y - point.y);
    if (d < distance) { distance = d; best = candidate; }
  }
  return best;
}

static CGEventRef protectRenderCursor(CGEventTapProxy, CGEventType type, CGEventRef event, void*) {
  if (type == kCGEventTapDisabledByTimeout) {
    if (renderCursorTap) CGEventTapEnable(renderCursorTap, true);
    return event;
  }
  if (!event || type == kCGEventTapDisabledByUserInput) return event;
  CGPoint point = CGEventGetLocation(event), projected = projectCursor(point);
  if (!CGPointEqualToPoint(point, projected)) {
    CGEventSetLocation(event, projected);
    CGWarpMouseCursorPosition(projected);
  }
  return event;
}

static napi_value startRenderCursorGuard(napi_env env, napi_callback_info) {
  if (!AXIsProcessTrusted()) {
    napi_throw_error(env, nullptr, "Для внутренней поверхности нужен Универсальный доступ PDM"); return nullptr;
  }
  refreshRenderScreens();
  if (!renderCursorTap) {
    CGEventMask mask = CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) |
      CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged) |
      CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
      CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp) |
      CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) | CGEventMaskBit(kCGEventScrollWheel);
    renderCursorTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
      kCGEventTapOptionDefault, mask, protectRenderCursor, nullptr);
    if (!renderCursorTap) {
      napi_throw_error(env, nullptr, "macOS не разрешила защитить курсор от внутренней поверхности"); return nullptr;
    }
    renderCursorSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, renderCursorTap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), renderCursorSource, kCFRunLoopCommonModes);
    CGEventTapEnable(renderCursorTap, true);
  }
  if (!CGEventTapIsEnabled(renderCursorTap)) CGEventTapEnable(renderCursorTap, true);
  napi_value result; napi_get_boolean(env, CGEventTapIsEnabled(renderCursorTap), &result); return result;
}

static napi_value refreshRenderCursorGuard(napi_env env, napi_callback_info) {
  if (renderCursorTap) refreshRenderScreens();
  napi_value result; napi_get_boolean(env, renderCursorTap && CGEventTapIsEnabled(renderCursorTap), &result); return result;
}

static napi_value stopRenderCursorGuard(napi_env env, napi_callback_info) {
  if (renderCursorSource) {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), renderCursorSource, kCFRunLoopCommonModes);
    CFRelease(renderCursorSource); renderCursorSource = nullptr;
  }
  if (renderCursorTap) { CFMachPortInvalidate(renderCursorTap); CFRelease(renderCursorTap); renderCursorTap = nullptr; }
  renderScreens.clear(); physicalScreens.clear();
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value projectRenderCursor(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  double x = 0, y = 0;
  if (count != 2 || napi_get_value_double(env, args[0], &x) != napi_ok || napi_get_value_double(env, args[1], &y) != napi_ok ||
      !std::isfinite(x) || !std::isfinite(y)) { napi_throw_error(env, nullptr, "Invalid cursor point"); return nullptr; }
  CGPoint point = projectCursor(CGPointMake(x, y));
  napi_value result; napi_create_array_with_length(env, 2, &result);
  napi_value value; napi_create_double(env, point.x, &value); napi_set_element(env, result, 0, value);
  napi_create_double(env, point.y, &value); napi_set_element(env, result, 1, value); return result;
}

static napi_value configureRenderDisplay(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  uint32_t renderID = 0, length = 0;
  bool array = false;
  if (count != 2 || napi_get_value_uint32(env, args[0], &renderID) != napi_ok ||
      napi_is_array(env, args[1], &array) != napi_ok || !array ||
      napi_get_array_length(env, args[1], &length) != napi_ok || length > 64 ||
      (renderID && (CGDisplayVendorNumber(renderID) != 0x5044 || CGDisplayModelNumber(renderID) != 0x4d52))) {
    napi_throw_error(env, nullptr, "Invalid rendering display layout"); return nullptr;
  }
  struct Position { uint32_t id; double x, y, width, height; };
  std::vector<Position> positions;
  double bottom = -INFINITY, left = 0;
  bool unchanged = true;
  for (uint32_t i = 0; i < length; i++) {
    napi_value item; napi_get_element(env, args[1], i, &item);
    double values[5];
    for (uint32_t j = 0; j < 5; j++) {
      napi_value number; napi_get_element(env, item, j, &number);
      if (napi_get_value_double(env, number, &values[j]) != napi_ok || !std::isfinite(values[j])) {
        napi_throw_error(env, nullptr, "Invalid rendering display coordinates"); return nullptr;
      }
    }
    if (values[0] < 1 || values[0] > UINT32_MAX || std::abs(values[1]) > 65536 || std::abs(values[2]) > 65536 ||
        values[3] < 1 || values[4] < 1) { napi_throw_error(env, nullptr, "Invalid rendering display bounds"); return nullptr; }
    Position p = {(uint32_t)values[0], values[1], values[2], values[3], values[4]};
    if (!CGDisplayIsOnline(p.id) || p.id == renderID) continue;
    positions.push_back(p);
    CGRect current = appDisplayBounds(p.id);
    unchanged &= current.origin.x == p.x && current.origin.y == p.y;
    if (p.y + p.height > bottom) { bottom = p.y + p.height; left = p.x; }
  }
  if (renderID) {
    CGRect current = appDisplayBounds(renderID);
    unchanged &= current.origin.x == left && current.origin.y == bottom;
  }
  CGError status = kCGErrorSuccess;
  if (!unchanged) {
    CGDisplayConfigRef config = nullptr;
    status = CGBeginDisplayConfiguration(&config);
    if (status == kCGErrorSuccess) {
      for (auto& p : positions) {
        status = CGConfigureDisplayOrigin(config, p.id, (int32_t)p.x, (int32_t)p.y);
        if (status != kCGErrorSuccess) break;
      }
      if (status == kCGErrorSuccess && renderID && std::isfinite(bottom))
        status = CGConfigureDisplayOrigin(config, renderID, (int32_t)left, (int32_t)bottom);
      if (status == kCGErrorSuccess) status = CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
      else CGCancelDisplayConfiguration(config);
    }
  }
  refreshRenderScreens();
  napi_value result; napi_get_boolean(env, status == kCGErrorSuccess, &result); return result;
}

// Retire the exact captured Office window even when Word's document object
// has already disappeared. A successful AppleScript close is not proof that
// its editor window has gone away.
static napi_value managedOfficeWindows(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    napi_value result; napi_create_array(env, &result); uint32_t index = 0;
    NSRegularExpression* pattern = [NSRegularExpression regularExpressionWithPattern:@"^PDM [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:$|[ \u2014-])" options:0 error:nil];
    NSArray* records = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
    for (NSDictionary* record in records) {
      NSString* title = record[(__bridge NSString*)kCGWindowName];
      if (!title || ![pattern firstMatchInString:title options:0 range:NSMakeRange(0,title.length)]) continue;
      pid_t pid = [record[(__bridge NSString*)kCGWindowOwnerPID] intValue];
      NSString* bundle = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].bundleIdentifier;
      if (![bundle isEqualToString:@"com.microsoft.Word"] && ![bundle isEqualToString:@"com.microsoft.Excel"]) continue;
      napi_value item, value; napi_create_object(env,&item);
      napi_create_string_utf8(env,bundle.UTF8String,NAPI_AUTO_LENGTH,&value); napi_set_named_property(env,item,"bundle",value);
      napi_create_string_utf8(env,title.UTF8String,NAPI_AUTO_LENGTH,&value); napi_set_named_property(env,item,"marker",value);
      napi_create_uint32(env,[record[(__bridge NSString*)kCGWindowNumber] unsignedIntValue],&value); napi_set_named_property(env,item,"windowId",value);
      napi_create_uint32(env,pid,&value); napi_set_named_property(env,item,"pid",value);
      napi_set_element(env,result,index++,item);
    }
    return result;
  }
}

static napi_value releaseDocumentWindow(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 4; napi_value args[4];
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    std::string bundle, marker; uint32_t windowID = 0, expectedPID = 0;
    if (count < 2 || !argument(env, args[0], bundle) || !argument(env, args[1], marker) ||
        (bundle != "com.microsoft.Word" && bundle != "com.microsoft.Excel") || marker.rfind("PDM ", 0) != 0) {
      napi_throw_error(env, nullptr, "Invalid Office window identifier"); return nullptr;
    }
    if (count > 2) napi_get_value_uint32(env, args[2], &windowID);
    if (count > 3) napi_get_value_uint32(env, args[3], &expectedPID);
    if (!AXIsProcessTrusted()) { napi_throw_error(env, nullptr, "PDM needs Accessibility permission to hide Office"); return nullptr; }
    NSArray* records = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID));
    NSDictionary* selected = nil; unsigned matches = 0;
    for (NSDictionary* entry in records) {
      uint32_t candidateID = [entry[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
      pid_t pid = [entry[(__bridge NSString*)kCGWindowOwnerPID] intValue];
      NSRunningApplication* running = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
      if (![running.bundleIdentifier isEqualToString:[NSString stringWithUTF8String:bundle.c_str()]]) continue;
      if (windowID) {
        if (candidateID != windowID || (expectedPID && pid != (pid_t)expectedPID)) continue;
        if (!expectedPID && ![entry[(__bridge NSString*)kCGWindowName] hasPrefix:[NSString stringWithUTF8String:marker.c_str()]]) continue;
      } else if (![[entry objectForKey:(__bridge NSString*)kCGWindowName] hasPrefix:[NSString stringWithUTF8String:marker.c_str()]]) continue;
      selected = entry; matches++;
    }
    bool gone = matches == 0;
    if (selected) windowID = [selected[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
    pid_t pid = selected ? [selected[(__bridge NSString*)kCGWindowOwnerPID] intValue] : (pid_t)expectedPID;
    if (matches > 1) { napi_throw_error(env, nullptr, "Office window identity is ambiguous"); return nullptr; }
    if (!gone && [selected[(__bridge NSString*)kCGWindowIsOnscreen] boolValue]) {
      windowID = [selected[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
      CGRect expected = CGRectZero;
      CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)selected[(__bridge NSString*)kCGWindowBounds], &expected);
      NSString* title = selected[(__bridge NSString*)kCGWindowName];
      AXUIElementRef application = AXUIElementCreateApplication(pid);
      AXUIElementSetMessagingTimeout(application, 2.0);
      CFTypeRef windows = nullptr;
      AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows);
      CFRelease(application);
      AXUIElementRef target = nullptr; unsigned candidates = 0;
      for (id value in (__bridge NSArray*)windows) {
        AXUIElementRef candidate = (__bridge AXUIElementRef)value; CGRect frame = CGRectZero;
        if (!frameOf(candidate, frame) || std::abs(frame.origin.x - expected.origin.x) > 2 ||
            std::abs(frame.origin.y - expected.origin.y) > 2 || std::abs(frame.size.width - expected.size.width) > 2 ||
            std::abs(frame.size.height - expected.size.height) > 2) continue;
        if (title.length && ![attributeString(candidate, kAXTitleAttribute) isEqualToString:title]) continue;
        target = candidate; candidates++;
      }
      bool hidden = false;
      AXError error = candidates == 1 ? AXUIElementSetAttributeValue(target, kAXMinimizedAttribute, kCFBooleanTrue) : kAXErrorNoValue;
      if (error == kAXErrorSuccess) for (unsigned attempt = 0; attempt < 40 && !hidden; attempt++) {
        CFTypeRef minimized = nullptr;
        error = AXUIElementCopyAttributeValue(target, kAXMinimizedAttribute, &minimized);
        hidden = error == kAXErrorSuccess && minimized && CFGetTypeID(minimized) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)minimized);
        if (minimized) CFRelease(minimized);
        if (!hidden) usleep(25000);
      }
      if (windows) CFRelease(windows);
      if (!hidden) {
        std::string message = "Office did not hide the managed document window (matches=" + std::to_string(candidates) + ", AX=" + std::to_string(error) + ")";
        napi_throw_error(env, nullptr, message.c_str()); return nullptr;
      }
    }
    napi_value result, value; napi_create_object(env, &result);
    napi_create_uint32(env, windowID, &value); napi_set_named_property(env, result, "windowId", value);
    napi_create_uint32(env, pid, &value); napi_set_named_property(env, result, "pid", value);
    napi_get_boolean(env, gone, &value); napi_set_named_property(env, result, "windowGone", value);
    return result;
  }
}

static NSArray* axChildren(AXUIElementRef element) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &value) != kAXErrorSuccess || !value) return @[];
  return CFBridgingRelease(value);
}

static AXUIElementRef keynoteWindow(uint32_t windowID) {
  NSArray* records = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowID));
  NSDictionary* record = records.firstObject;
  pid_t pid = [record[(__bridge NSString*)kCGWindowOwnerPID] intValue];
  NSRunningApplication* running = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!record || !keynoteBundleIdentifier(running.bundleIdentifier)) return nullptr;
  CGRect expected = CGRectZero;
  if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)record[(__bridge NSString*)kCGWindowBounds], &expected)) return nullptr;
  NSString* title = record[(__bridge NSString*)kCGWindowName];
  AXUIElementRef application = AXUIElementCreateApplication(pid);
  AXUIElementSetMessagingTimeout(application, 2.0);
  CFTypeRef windows = nullptr;
  AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows);
  CFRelease(application);
  AXUIElementRef selected = nullptr; unsigned matches = 0;
  for (id value in (__bridge NSArray*)windows) {
    AXUIElementRef candidate = (__bridge AXUIElementRef)value;
    CGRect frame = CGRectZero;
    if (!frameOf(candidate, frame) || std::abs(frame.origin.x - expected.origin.x) > 2 ||
        std::abs(frame.origin.y - expected.origin.y) > 2 || std::abs(frame.size.width - expected.size.width) > 2 ||
        std::abs(frame.size.height - expected.size.height) > 2) continue;
    if (title.length && ![attributeString(candidate, kAXTitleAttribute) isEqualToString:title]) continue;
    selected = candidate; matches++;
  }
  if (matches == 1) CFRetain(selected); else selected = nullptr;
  if (windows) CFRelease(windows);
  return selected;
}

static AXUIElementRef windowedMenuItem(AXUIElementRef play) {
  NSArray* menus = axChildren(play);
  if (!menus.count) return nullptr;
  NSArray* items = axChildren((__bridge AXUIElementRef)menus[0]);
  for (id item in items) {
    NSString* title = attributeString((__bridge AXUIElementRef)item, kAXTitleAttribute);
    if ([title isEqualToString:@"In Window"] || [title isEqualToString:@"В окне"]) return (AXUIElementRef)CFRetain((__bridge AXUIElementRef)item);
  }
  return items.count > 4 ? (AXUIElementRef)CFRetain((__bridge AXUIElementRef)items[4]) : nullptr;
}

static AXUIElementRef waitForKeynoteWindow(uint32_t windowID) {
  // Unhide, staging and a new player window update WindowServer and AX on
  // different turns. Never reject a real window just because its AX bounds
  // still describe the previous turn. Keep the exact identity/geometry check.
  for (unsigned attempt = 0; attempt < 30; attempt++) {
    AXUIElementRef window = keynoteWindow(windowID);
    if (window) return window;
    usleep(50000);
  }
  return nullptr;
}

static napi_value prepareKeynotePlayback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 1; napi_value arguments[1]; uint32_t windowID = 0;
    napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr);
    if (count < 1 || napi_get_value_uint32(env, arguments[0], &windowID) != napi_ok || !AXIsProcessTrusted()) {
      napi_throw_error(env, nullptr, "Для живого PPTX включите Универсальный доступ для PDM в настройках macOS"); return nullptr;
    }
    NSArray* records = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowID));
    pid_t ownerPID = [records.firstObject[(__bridge NSString*)kCGWindowOwnerPID] intValue];
    NSRunningApplication* keynote = [NSRunningApplication runningApplicationWithProcessIdentifier:ownerPID];
    if (!keynoteBundleIdentifier(keynote.bundleIdentifier)) {
      napi_throw_error(env, nullptr, "Keynote window owner has exited"); return nullptr;
    }
    NSRunningApplication* foreground = NSWorkspace.sharedWorkspace.frontmostApplication;
    [keynote unhide];
    AXUIElementRef target = waitForKeynoteWindow(windowID);
    if (!target) { napi_throw_error(env, nullptr, "Не найдено подготовленное окно документа Keynote"); return nullptr; }
    AXUIElementSetAttributeValue(target, kAXMainAttribute, kCFBooleanTrue);
    AXUIElementSetAttributeValue(target, kAXFocusedAttribute, kCFBooleanTrue);
    AXUIElementPerformAction(target, kAXRaiseAction);
    CFRelease(target);
    AXUIElementRef application = AXUIElementCreateApplication(keynote.processIdentifier);
    AXUIElementSetMessagingTimeout(application, 2.0);
    CFTypeRef bar = nullptr; AXUIElementCopyAttributeValue(application, kAXMenuBarAttribute, &bar);
    CFRelease(application);
    AXUIElementRef play = nullptr;
    NSArray* entries = bar ? axChildren((AXUIElementRef)bar) : @[];
    for (id entry in entries) {
      NSString* title = attributeString((__bridge AXUIElementRef)entry, kAXTitleAttribute);
      if ([title isEqualToString:@"Play"] || [title isEqualToString:@"Воспроизведение"]) play = (__bridge AXUIElementRef)entry;
    }
    if (!play && entries.count > 9) play = (__bridge AXUIElementRef)entries[9];
    AXUIElementRef item = play ? windowedMenuItem(play) : nullptr;
    BOOL selected = item && attributeString(item, CFSTR("AXMenuItemMarkChar")).length > 0;
    if (!selected && keynoteHasWindowedLaunch(ownerPID)) selected = YES;
    if (!selected && play) {
      AXUIElementPerformAction(play, kAXPressAction);
      if (item) CFRelease(item);
      item = windowedMenuItem(play);
      if (item) AXUIElementPerformAction(item, kAXPressAction);
      for (unsigned attempt = 0; attempt < 10 && !selected; attempt++) {
        usleep(50000);
        selected = item && attributeString(item, CFSTR("AXMenuItemMarkChar")).length > 0;
      }
      if (!selected) {
        NSArray* menus = axChildren(play);
        if (menus.count) AXUIElementPerformAction((__bridge AXUIElementRef)menus[0], kAXCancelAction);
      }
    }
    if (item) CFRelease(item);
    if (bar) CFRelease(bar);
    if (foreground && foreground.processIdentifier != keynote.processIdentifier &&
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == keynote.processIdentifier)
      [foreground activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    if (!selected) { napi_throw_error(env, nullptr, "Keynote не подтвердил воспроизведение «В окне» для выбранного документа"); return nullptr; }
    napi_value result; napi_get_boolean(env, true, &result); return result;
  }
}

static void collectWindowRoles(AXUIElementRef element, unsigned depth, bool& toolbar, bool& split) {
  NSString* role = attributeString(element, kAXRoleAttribute);
  toolbar |= [role isEqualToString:(__bridge NSString*)kAXToolbarRole];
  split |= [role isEqualToString:(__bridge NSString*)kAXSplitGroupRole];
  if (depth) for (id child in axChildren(element)) collectWindowRoles((__bridge AXUIElementRef)child, depth - 1, toolbar, split);
}

static napi_value verifyKeynotePlayback(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 1; napi_value argument; uint32_t windowID = 0;
    napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
    if (count != 1 || napi_get_value_uint32(env, argument, &windowID) != napi_ok) {
      napi_throw_error(env, nullptr, "Invalid Keynote playback window"); return nullptr;
    }
    AXUIElementRef window = waitForKeynoteWindow(windowID);
    if (!window) { napi_throw_error(env, nullptr, "Keynote не предоставил проверяемое окно показа"); return nullptr; }
    bool toolbar = false, split = false;
    collectWindowRoles(window, 3, toolbar, split); CFRelease(window);
    if (toolbar && split) { napi_throw_error(env, nullptr, "Keynote открыл редактор вместо окна показа; переключение отменено"); return nullptr; }
    napi_value result; napi_get_boolean(env, true, &result); return result;
  }
}

#include "mac-keynote-bridge.h"

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "prepareDocumentWindow", NAPI_AUTO_LENGTH, prepareDocumentWindow, nullptr, &function);
  napi_set_named_property(env, exports, "prepareDocumentWindow", function);
  struct { const char* name; napi_callback callback; } functions[] = {
    {"restoreMacDockVisibility", restoreMacDockVisibility},
    {"keynoteControl", keynoteControl},
    {"releaseDocumentWindow", releaseDocumentWindow},
    {"managedOfficeWindows", managedOfficeWindows},
    {"startRenderCursorGuard", startRenderCursorGuard}, {"refreshRenderCursorGuard", refreshRenderCursorGuard},
    {"stopRenderCursorGuard", stopRenderCursorGuard}, {"projectRenderCursor", projectRenderCursor},
    {"configureRenderDisplay", configureRenderDisplay},
    {"prepareKeynotePlayback", prepareKeynotePlayback}, {"verifyKeynotePlayback", verifyKeynotePlayback}
  };
  for (auto& entry : functions) {
    napi_create_function(env, entry.name, NAPI_AUTO_LENGTH, entry.callback, nullptr, &function);
    napi_set_named_property(env, exports, entry.name, function);
  }
  return exports;
}
NAPI_MODULE(macOfficeAccessibility, initialize)
