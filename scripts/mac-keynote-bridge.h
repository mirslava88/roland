// Minimal typed ScriptingBridge declarations from the installed Keynote SDEF.
// Every event is addressed to a verified PID, never the default application.
#import <ScriptingBridge/ScriptingBridge.h>
@class PDMKeynoteDocument, PDMKeynoteSlide;
@interface PDMKeynoteWindow : SBObject
- (NSInteger)id;
@property(copy,readonly) NSString *name;
@property NSRect bounds;
@property BOOL visible;
@property BOOL miniaturized;
@property NSInteger index;
@end
@interface PDMKeynoteSlide : SBObject
@property(readonly) NSInteger slideNumber;
@property(copy) SBObject *presenterNotes;
@end
@interface PDMKeynoteDocument : SBObject
- (NSString *)id;
@property(copy,readonly) NSString *name;
@property(copy,readonly) NSURL *file;
- (SBElementArray *)slides;
@property(copy) PDMKeynoteSlide *currentSlide;
- (void)startFrom:(PDMKeynoteSlide *)slide;
- (void)stop;
- (void)closeSaving:(OSType)saving savingIn:(NSURL *)destination;
- (void)exportTo:(NSURL *)destination as:(OSType)format withProperties:(NSDictionary *)properties;
@end
@interface PDMKeynoteApplication : SBApplication
- (SBElementArray *)documents;
- (SBElementArray *)windows;
- (id)open:(id)files;
- (void)showNext;
- (void)showPrevious;
- (void)quitSaving:(OSType)saving;
@end
@interface PDMKeynoteEvents : NSObject<SBApplicationDelegate>
@property(strong) NSError *error;
@end
@implementation PDMKeynoteEvents
- (id)eventDidFail:(const AppleEvent *)event withError:(NSError *)error { self.error=error; return nil; }
@end
static void keynoteCheck(PDMKeynoteEvents *events) {
  if (events.error) @throw [NSException exceptionWithName:@"Keynote" reason:events.error.description userInfo:nil];
}
// WindowServer supplies a stable snapshot with real positive window IDs.
// Keynote's scripting window list also contains transient id=-1 placeholders;
// enumerating those proxies can throw or poison the next Apple event.
static NSArray<NSDictionary *> *keynoteWindowRecords(pid_t pid, NSString *name) {
 NSArray *windows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionAll,kCGNullWindowID));
 NSMutableArray *result=[NSMutableArray array];
 for(NSDictionary *entry in windows) {
  if([entry[(__bridge NSString *)kCGWindowOwnerPID] intValue]!=pid ||
     [entry[(__bridge NSString *)kCGWindowLayer] intValue]!=0 ||
     [entry[(__bridge NSString *)kCGWindowNumber] intValue]<=0 ||
     ![entry[(__bridge NSString *)kCGWindowName] isEqualToString:name])continue;
  CGRect bounds; if(!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)entry[(__bridge NSString *)kCGWindowBounds],&bounds))continue;
  if(bounds.size.width<100||bounds.size.height<100)continue;
  [result addObject:entry];
 }
 return result;
}
static void keynotePlacePlayer(PDMKeynoteApplication *app, pid_t pid, NSInteger identifier, NSRect box) {
 PDMKeynoteWindow *window=[[app windows] objectWithID:@(identifier)];
 unsigned stable=0;
 for(unsigned attempt=0;attempt<40;attempt++) {
  NSArray *records=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,(CGWindowID)identifier));
  NSDictionary *entry=records.firstObject;CGRect actual=CGRectZero;
  BOOL exact=entry&&[entry[(__bridge NSString *)kCGWindowOwnerPID] intValue]==pid&&
   CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)entry[(__bridge NSString *)kCGWindowBounds],&actual)&&
   fabs(actual.origin.x-box.origin.x)<2&&fabs(actual.origin.y-box.origin.y)<2&&
   fabs(actual.size.width-box.size.width)<2&&fabs(actual.size.height-box.size.height)<2;
  if(exact){stable++;if(attempt>=12&&stable>=4)return;}
  else {stable=0;window.bounds=box;keynoteCheck((id)app.delegate);}
  usleep(50000);
 }
 @throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote did not keep the requested rendering bounds" userInfo:nil];
}
static PDMKeynoteDocument *keynoteDocument(PDMKeynoteApplication *app, NSString *identifier) {
  for(PDMKeynoteDocument *document in (NSArray *)[[app documents] get])
    if([[document id] isEqualToString:identifier]) return [[app documents] objectWithID:identifier];
  @throw [NSException exceptionWithName:@"Keynote" reason:@"Prepared presentation is no longer open" userInfo:nil];
}
static NSDictionary *keynoteMetadata(PDMKeynoteDocument *document) {
  return @{@"documentId":[document id]?:@"",@"slideCount":@([[document slides] count]),
    @"slide":@([[document currentSlide] slideNumber])};
}
static void keynoteHideEditors(PDMKeynoteApplication *app, pid_t pid, NSString *name, NSInteger except) {
 PDMKeynoteEvents *events=(id)app.delegate;
 for(NSDictionary *entry in keynoteWindowRecords(pid,name)) {
  NSNumber *identifier=entry[(__bridge NSString *)kCGWindowNumber];
  if(identifier.integerValue==except)continue;
  NSError *previous=events.error;
  PDMKeynoteWindow *window=[[app windows] objectWithID:identifier];
  window.visible=NO;
  // An editor may already have disappeared after Start/Stop. This optional
  // cleanup must not replace a successful command with a stale-object error.
  if(events.error.code==-1728)events.error=previous;
 }
}
static bool keynoteSameFile(NSURL *file, NSURL *requested) {
  return [file isKindOfClass:NSURL.class] &&
    [file.URLByStandardizingPath.URLByResolvingSymlinksInPath.path isEqualToString:requested.URLByStandardizingPath.URLByResolvingSymlinksInPath.path];
}
static napi_value keynoteControl(napi_env env, napi_callback_info info) {
 @autoreleasepool {
  size_t count=3; napi_value values[3]; uint32_t pid=0; std::string operation,encoded;
  napi_get_cb_info(env,info,&count,values,nullptr,nullptr);
  if(count!=3 || napi_get_value_uint32(env,values[0],&pid)!=napi_ok || !argument(env,values[1],operation) || !argument(env,values[2],encoded)) {
   napi_throw_error(env,nullptr,"Invalid Keynote operation");return nullptr;
  }
  NSRunningApplication *foreground=NSWorkspace.sharedWorkspace.frontmostApplication;
  @try {
   NSString *action=[NSString stringWithUTF8String:operation.c_str()];
   NSArray *args=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:encoded.c_str()] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
   if(![args isKindOfClass:NSArray.class]) @throw [NSException exceptionWithName:@"Keynote" reason:@"Invalid arguments" userInfo:nil];
   id result=@{};
   if([action isEqualToString:@"processes"]) {
    NSMutableArray *items=[NSMutableArray array];
    for(NSString *identifier in keynoteBundleIdentifiers())
     for(NSRunningApplication *running in [NSRunningApplication runningApplicationsWithBundleIdentifier:identifier]) {
      if(running.terminated)continue;
      NSMutableDictionary *item=[NSMutableDictionary dictionaryWithDictionary:keynoteApplicationInfo(running.bundleURL) ?: @{}];
      item[@"pid"]=@(running.processIdentifier);item[@"bundleId"]=identifier;
      [items addObject:item];
     }
    result=items;
   } else if([action isEqualToString:@"application"]) {
    result=nil;
    for(NSString *identifier in keynoteBundleIdentifiers()) {
     NSURL *url=[NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:identifier];
     result=keynoteApplicationInfo(url);
     if(result)break;
    }
    if(!result)@throw [NSException exceptionWithName:@"Keynote" reason:@"Для показа PPTX установите Keynote и запустите его один раз вручную" userInfo:nil];
   } else {
    NSRunningApplication *running=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if(!keynoteBundleIdentifier(running.bundleIdentifier))
     @throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote process has exited" userInfo:nil];
    PDMKeynoteApplication *app=(id)[SBApplication applicationWithProcessIdentifier:pid];
    PDMKeynoteEvents *events=[PDMKeynoteEvents new]; app.delegate=events;
    app.sendMode=kAEWaitReply|kAENeverInteract;
    if([action isEqualToString:@"state"]) {
     result=@{@"playing":@([[app valueForKey:@"playing"] boolValue]),@"documents":@([[app documents] count])};
    } else if([action isEqualToString:@"quit"]) {
     if([[app documents] count]) @throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote still has open documents; leaving the process running" userInfo:nil];
     [app quitSaving:'no  '];
    } else if([action isEqualToString:@"import"]) {
     if([[app valueForKey:@"playing"] boolValue]) @throw [NSException exceptionWithName:@"Keynote" reason:@"Worker is already playing" userInfo:nil];
     [running hide];
     NSString *path=args[0]; NSString *expected=[path.lastPathComponent stringByDeletingPathExtension];
     NSURL *requested=[NSURL fileURLWithPath:path];
     NSMutableSet *before=[NSMutableSet setWithArray:[(NSArray *)[[app documents] get] valueForKey:@"id"]];
     PDMKeynoteDocument *opened=nil;
     for(PDMKeynoteDocument *candidate in (NSArray *)[[app documents] get]) if(keynoteSameFile(candidate.file,requested)) {
      opened=[[app documents] objectWithID:[candidate id]];break;
     }
     if(!opened) { [app open:requested]; keynoteCheck(events); }
     for(int attempt=0;attempt<200&&!opened;attempt++) {
      for(PDMKeynoteDocument *candidate in (NSArray *)[[app documents] get]) {
       NSString *name=candidate.name;
       if(keynoteSameFile(candidate.file,requested) || (![before containsObject:[candidate id]] && ([name isEqualToString:expected] || [name isEqualToString:path.lastPathComponent] || [name hasPrefix:[expected stringByAppendingString:@" "]]))) {
        opened=[[app documents] objectWithID:[candidate id]]; break;
       }
      }
      if(!opened) usleep(25000);
     }
     if(!opened) @throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote did not import the requested presentation" userInfo:nil];
     keynoteHideEditors(app,pid,opened.name,0); result=keynoteMetadata(opened);
    } else if([action isEqualToString:@"refresh"] || [action isEqualToString:@"relocate"]) {
     NSInteger identifier=[args[0] integerValue]; PDMKeynoteWindow *window=[[app windows] objectWithID:@(identifier)];
     if([action isEqualToString:@"relocate"]) keynotePlacePlayer(app,pid,identifier,NSMakeRect([args[1] doubleValue],[args[2] doubleValue],[args[3] doubleValue],[args[4] doubleValue]));
     else {
      NSArray *records=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,(CGWindowID)identifier));
      NSDictionary *entry=records.firstObject;CGRect actual=CGRectZero;
      if(!entry||[entry[(__bridge NSString *)kCGWindowOwnerPID] intValue]!=pid||
        !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)entry[(__bridge NSString *)kCGWindowBounds],&actual))
       @throw [NSException exceptionWithName:@"Keynote" reason:@"Player window is no longer available" userInfo:nil];
      // ScriptingBridge can return stale pre-placement bounds here. Preserve
      // WindowServer's actual geometry while forcing a fresh static frame.
      NSRect box=NSMakeRect(actual.origin.x,actual.origin.y,actual.size.width,actual.size.height);
      window.bounds=NSMakeRect(box.origin.x,box.origin.y,box.size.width+1,box.size.height+1);
      usleep(50000);
      window.bounds=box;
      keynotePlacePlayer(app,pid,identifier,box);
     }
    } else {
     PDMKeynoteDocument *document=keynoteDocument(app,args[0]);
     if([action isEqualToString:@"save"]) {
      // Knff in Keynote's SDEF selects the iCloud .key-tef format, not a
      // local .key file. Omit the optional format as in normal Keynote Save.
      [document sendEvent:'core' id:'save' parameters:'kfil',[NSURL fileURLWithPath:args[1]],0]; keynoteCheck(events);
      if(![[NSFileManager defaultManager] fileExistsAtPath:args[1]])
       @throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote did not finish saving its native working copy" userInfo:nil];
      // Saving an imported document can change its script identifier.
      // Rebind by its exact stable working path before returning ownership.
      for(PDMKeynoteDocument *candidate in (NSArray *)[[app documents] get]) if(keynoteSameFile(candidate.file,[NSURL fileURLWithPath:args[1]])) {
       document=[[app documents] objectWithID:[candidate id]]; break;
      }
      keynoteHideEditors(app,pid,document.name,0); result=keynoteMetadata(document);
     } else if([action isEqualToString:@"exportpdf"]) {
      [document exportTo:[NSURL fileURLWithPath:args[1]] as:'Kpdf' withProperties:@{}]; keynoteCheck(events);
      NSDictionary *attributes=[[NSFileManager defaultManager] attributesOfItemAtPath:args[1] error:nil];
      if([attributes fileSize]<5) @throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote did not export a complete PDF" userInfo:nil];
      keynoteHideEditors(app,pid,document.name,0); result=keynoteMetadata(document);
     } else if([action isEqualToString:@"inspect"]) result=keynoteMetadata(document);
     else if([action isEqualToString:@"stage"]) {
      NSString *name=document.name;
      // A document can remain imported after Keynote removes its hidden
      // editor window. Reopen only our working file to recreate that editor.
      if(keynoteWindowRecords(pid,name).count==0) {
       [running hide];
       [app open:document.file];keynoteCheck(events);
      }
      PDMKeynoteWindow *editor=[[app windows] objectWithName:name];
      NSRect box=NSMakeRect([args[1] doubleValue],[args[2] doubleValue],1280,720);
      editor.bounds=box; editor.miniaturized=NO;editor.visible=YES;editor.index=1;editor.bounds=box;
      keynoteCheck(events);
      NSInteger identifier=0;
      for(int attempt=0;attempt<80&&!identifier;attempt++) {
       for(NSDictionary *entry in keynoteWindowRecords(pid,name)) {
        CGRect bounds;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)entry[(__bridge NSString *)kCGWindowBounds],&bounds);
        // Editor minimum sizes vary with the deck/sidebar. Only the player
        // needs exact broadcast dimensions; the editor must stay parked.
        if(fabs(bounds.origin.x-box.origin.x)<2&&fabs(bounds.origin.y-box.origin.y)<2) {
         identifier=[entry[(__bridge NSString *)kCGWindowNumber] integerValue];break;
        }
       }
       if(!identifier) {
        // A display-mode change can re-clamp the editor after the first
        // placement. Rebind after Stop and keep enforcing the parked bounds.
        editor=[[app windows] objectWithName:name];
        editor.bounds=box;editor.miniaturized=NO;editor.visible=YES;editor.bounds=box;
        keynoteCheck(events);
        usleep(25000);
       }
      }
      if(!identifier)@throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote did not create its editor window" userInfo:nil];
      result=@{@"windowId":@(identifier)};
     } else if([action isEqualToString:@"start"]) {
      NSInteger slide=[args[1] integerValue],total=[[document slides] count];
      if(slide<1||slide>total) @throw [NSException exceptionWithName:@"Keynote" reason:@"Slide is outside presentation" userInfo:nil];
      NSString *name=document.name;
      NSMutableSet *previous=[NSMutableSet set];
      for(NSDictionary *entry in keynoteWindowRecords(pid,name)) [previous addObject:entry[(__bridge NSString *)kCGWindowNumber]];
      [document startFrom:[[document slides] objectAtIndex:slide-1]]; keynoteCheck(events);
      NSNumber *identifier=nil;
      for(int attempt=0;attempt<100&&!identifier;attempt++) {
       double area=DBL_MAX;
       for(NSDictionary *entry in keynoteWindowRecords(pid,name)) {
        NSNumber *number=entry[(__bridge NSString *)kCGWindowNumber];if([previous containsObject:number])continue;
        CGRect bounds;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)entry[(__bridge NSString *)kCGWindowBounds],&bounds);
        double candidate=bounds.size.width*bounds.size.height;
        if(candidate>0&&candidate<area){identifier=number;area=candidate;}
       }
       if(!identifier)usleep(20000);
      }
      if(!identifier)@throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote player did not appear" userInfo:nil];
      PDMKeynoteWindow *player=[[app windows] objectWithID:identifier];
      NSRect box=NSMakeRect([args[2] doubleValue],[args[3] doubleValue],[args[4] doubleValue],[args[5] doubleValue]);
      keynotePlacePlayer(app,pid,identifier.integerValue,box);
      keynoteHideEditors(app,pid,name,identifier.integerValue);
      NSMutableDictionary *metadata=[keynoteMetadata(document) mutableCopy];metadata[@"windowId"]=identifier;result=metadata;
     } else if([action isEqualToString:@"stop"] || [action isEqualToString:@"close"]) {
      if([[app valueForKey:@"playing"] boolValue]) {
       [document stop];
       // A different document in this process may own the player. Closing
       // an idle managed editor still works when its STOP is not applicable.
       if([action isEqualToString:@"close"] && events.error.code==-1708) events.error=nil;
       keynoteCheck(events);
       if(args.count>1) {
        CGWindowID previous=[args[1] unsignedIntValue];BOOL gone=NO;
        for(unsigned attempt=0;attempt<80&&!gone;attempt++) {
         NSArray *records=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,previous));
         gone=records.count==0;
         if(!gone)usleep(25000);
        }
        if(!gone)@throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote did not release its previous player window" userInfo:nil];
       }
      }
      keynoteHideEditors(app,pid,document.name,0);
      if([action isEqualToString:@"close"]) [document closeSaving:'no  ' savingIn:nil];
     } else if([action isEqualToString:@"notes"]) {
      NSInteger slide=[args[1] integerValue];
      if(slide<1||slide>[[document slides] count]) result=@{@"notes":@""};
      else { PDMKeynoteSlide *item=[[document slides] objectAtIndex:slide-1];id notes=[item.presenterNotes get];result=@{@"notes":[notes isKindOfClass:NSString.class]?notes:@""}; }
     } else if([action isEqualToString:@"next"] || [action isEqualToString:@"prev"] || [action isEqualToString:@"goto"] || [action isEqualToString:@"current"]) {
      if(![[app valueForKey:@"playing"] boolValue]) @throw [NSException exceptionWithName:@"Keynote" reason:@"Keynote slideshow is no longer playing" userInfo:nil];
      if([action isEqualToString:@"next"]) [app showNext];
      else if([action isEqualToString:@"prev"]) [app showPrevious];
      else if([action isEqualToString:@"goto"]) {
       NSInteger slide=[args[1] integerValue]; if(slide<1||slide>[[document slides] count]) @throw [NSException exceptionWithName:@"Keynote" reason:@"Slide is outside presentation" userInfo:nil];
       document.currentSlide=[[document slides] objectAtIndex:slide-1];
      }
      result=keynoteMetadata(document);
     } else @throw [NSException exceptionWithName:@"Keynote" reason:@"Unsupported Keynote operation" userInfo:nil];
    }
    keynoteCheck(events);
   }
   NSData *json=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:nil];
   NSString *text=[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
   napi_value value;napi_create_string_utf8(env,text.UTF8String,NAPI_AUTO_LENGTH,&value);return value;
  } @catch(NSException *error) { napi_throw_error(env,nullptr,error.reason.UTF8String);return nullptr; }
  @finally {
   if(foreground && foreground.processIdentifier!=(pid_t)pid &&
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==(pid_t)pid)
     [foreground activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  }
 }
}
