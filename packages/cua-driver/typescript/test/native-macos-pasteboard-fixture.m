#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <stdlib.h>
#include <string.h>

static NSPasteboard *private_pasteboard;

static id nullable_pasteboard(id receiver, SEL selector) {
    const char *flag = getenv("CUA_TEST_NIL_PASTEBOARD");
    if (flag && strcmp(flag, "1") == 0) return nil;
    return private_pasteboard;
}

// This fixture changes only the test child process, never the system clipboard.
__attribute__((constructor)) static void install(void) {
    private_pasteboard = [[NSPasteboard pasteboardWithUniqueName] retain];
    Method method = class_getClassMethod([NSPasteboard class], @selector(generalPasteboard));
    method_setImplementation(method, (IMP)nullable_pasteboard);
}
