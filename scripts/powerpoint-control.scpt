-- PowerPoint for Mac bridge. All file names are passed as argv, never interpolated
-- into AppleScript source. The caller serializes operations on this single Office instance.

on sameFile(firstPath, secondPath)
    try
        return ((POSIX file firstPath) as alias) is ((POSIX file secondPath) as alias)
    on error
        return false
    end try
end sameFile

on findPresentation(sourcePath)
    tell application "Microsoft PowerPoint"
        set matches to presentations whose full name is sourcePath
        if (count of matches) > 0 then return item 1 of matches
        -- Office resolves aliases such as /private/tmp to /tmp. Compare file
        -- identity too, otherwise a successfully opened deck is retried until
        -- timeout and left behind as an apparently user-owned window.
        repeat with candidate in every presentation
            try
                if my sameFile(sourcePath, full name of candidate) then return contents of candidate
            end try
        end repeat
        return missing value
    end tell
end findPresentation

on openPresentation(sourcePath)
    -- Asking for the application object would otherwise launch PowerPoint
    -- visibly before we can request a background document import.
    try
        do shell script "/usr/bin/pgrep -x 'Microsoft PowerPoint' >/dev/null"
    on error
        do shell script "/usr/bin/open -gj -a " & quoted form of "Microsoft PowerPoint"
    end try
    set targetPres to my findPresentation(sourcePath)
    set openedByPdm to false
    set shouldHideAfterOpen to false
    if targetPres is missing value then
        -- Launch Services grants sandboxed Office access to the file. An
        -- AppleScript "open" alone can leave a hidden file-access dialog up
        -- until our 120-second export timeout expires.
        -- When PowerPoint has no windows, ask Launch Services to keep it
        -- hidden while it imports/exports. Never hide user-owned windows.
        tell application "Microsoft PowerPoint" to set hasVisibleWindows to (count of windows) > 0
        set shouldHideAfterOpen to not hasVisibleWindows
        if hasVisibleWindows then
            set openFlags to "-g"
        else
            set openFlags to "-gj"
        end if
        do shell script "/usr/bin/open " & openFlags & " -a " & quoted form of "Microsoft PowerPoint" & " " & quoted form of sourcePath
        set openedByPdm to true
        repeat 150 times
            set targetPres to my findPresentation(sourcePath)
            if targetPres is not missing value then exit repeat
            delay 0.1
        end repeat
    end if
    if targetPres is missing value then error "PowerPoint did not open the requested presentation"
    if openedByPdm and shouldHideAfterOpen then
        -- Launch Services may reveal Office even with -j when a file is
        -- supplied. Hiding the process leaves its document open for PDF export.
        try
            tell application "System Events" to set visible of process "Microsoft PowerPoint" to false
        end try
    end if
    return {targetPres, openedByPdm}
end openPresentation

on openManagedPresentation(sourcePath)
    -- This copy is inside PowerPoint's own cache: direct Apple events can
    -- open it without Launch Services' asynchronous file-permission handoff.
    try
        do shell script "/usr/bin/pgrep -x 'Microsoft PowerPoint' >/dev/null"
    on error
        do shell script "/usr/bin/open -gj -a " & quoted form of "Microsoft PowerPoint"
    end try
    log "PDM preview: open"
    tell application "Microsoft PowerPoint" to open POSIX file sourcePath
    log "PDM preview: opened"
    set targetPres to missing value
    repeat 100 times
        set targetPres to my findPresentation(sourcePath)
        if targetPres is not missing value then exit repeat
        delay 0.05
    end repeat
    if targetPres is missing value then error "PowerPoint did not open its managed preview copy"
    log "PDM preview: found"
    return {targetPres, true}
end openManagedPresentation

on hidePowerPointWhenIdle()
    tell application "Microsoft PowerPoint" to set openWindowCount to count of windows
    if openWindowCount is 0 then
        try
            tell application "System Events" to set visible of process "Microsoft PowerPoint" to false
        end try
    end if
end hidePowerPointWhenIdle

on run argv
    if (count of argv) is 0 then error "PowerPoint action is required"
    set actionName to item 1 of argv
    if actionName is "metadata" then
        set sourcePath to item 2 of argv
        set {targetPres, openedByPdm} to my openPresentation(sourcePath)
        tell application "Microsoft PowerPoint"
            set slideCount to count of slides of targetPres
            set slideWidth to slide width of page setup of targetPres
            if openedByPdm then close targetPres
        end tell
        if openedByPdm then my hidePowerPointWhenIdle()
        return (slideCount as text) & tab & (slideWidth as text)
    else if actionName is "exportpdf" then
        set sourcePath to item 2 of argv
        set destinationPath to item 3 of argv
        if (count of argv) > 3 and item 4 of argv is "managed-copy" then
            set {targetPres, openedByPdm} to my openManagedPresentation(sourcePath)
        else
            set {targetPres, openedByPdm} to my openPresentation(sourcePath)
        end if
        tell application "Microsoft PowerPoint"
            try
                log "PDM preview: save"
                save targetPres in (POSIX file destinationPath) as save as PDF
                log "PDM preview: saved"
            on error errorMessage number errorNumber
                if openedByPdm then close targetPres
                error errorMessage number errorNumber
            end try
            if openedByPdm then close targetPres
        end tell
        if openedByPdm then my hidePowerPointWhenIdle()
        return "ok"
    else if actionName is "open" then
        set sourcePath to item 2 of argv
        set startSlide to (item 3 of argv) as integer
        set displayX to (item 4 of argv) as integer
        set displayY to (item 5 of argv) as integer
        set displayWidth to (item 6 of argv) as integer
        set displayHeight to (item 7 of argv) as integer
        set {targetPres, openedByPdm} to my openPresentation(sourcePath)
        tell application "Microsoft PowerPoint"
            set slideCount to count of slides of targetPres
            if startSlide < 1 or startSlide > slideCount then error "Slide is outside presentation"
            set showSettings to slide show settings of targetPres
            set show with presenter of showSettings to false
            set show type of showSettings to slide show type window
            set loop until stopped of showSettings to true
            set starting slide of showSettings to startSlide
            set showWindow to run slide show showSettings
            set bounds of showWindow to {displayX, displayY, displayX + displayWidth, displayY + displayHeight}
            activate
        end tell
        return (slideCount as text) & tab & (startSlide as text) & tab & (openedByPdm as text)
    else if actionName is "relocate" then
        set displayX to (item 2 of argv) as integer
        set displayY to (item 3 of argv) as integer
        set displayWidth to (item 4 of argv) as integer
        set displayHeight to (item 5 of argv) as integer
        tell application "Microsoft PowerPoint"
            set bounds of slide show window 1 to {displayX, displayY, displayX + displayWidth, displayY + displayHeight}
        end tell
        return "ok"
    else if actionName is "close" then
        set sourcePath to item 2 of argv
        set openedByPdm to (item 3 of argv) is "true"
        set targetPres to my findPresentation(sourcePath)
        if targetPres is not missing value then
            tell application "Microsoft PowerPoint"
                try
                    exit slide show slide show view of slide show window of targetPres
                end try
                if openedByPdm then close targetPres
            end tell
            if openedByPdm then my hidePowerPointWhenIdle()
        end if
        return "ok"
    else if actionName is "next" or actionName is "prev" or actionName is "goto" or actionName is "current" then
        if actionName is "next" or actionName is "prev" then
            -- Keyboard navigation advances animation and embedded-media steps.
            tell application "Microsoft PowerPoint" to activate
            tell application "System Events"
                if actionName is "next" then
                    key code 124
                else
                    key code 123
                end if
            end tell
            delay 0.35
        else if actionName is "goto" then
            set slideNumber to (item 2 of argv) as integer
            tell application "Microsoft PowerPoint" to activate
            tell application "System Events"
                keystroke (slideNumber as text)
                key code 36
            end tell
            repeat 30 times
                tell application "Microsoft PowerPoint"
                    if slide number of slide of slide show view of slide show window 1 is slideNumber then exit repeat
                end tell
                delay 0.1
            end repeat
        end if
        tell application "Microsoft PowerPoint"
            return slide number of slide of slide show view of slide show window 1
        end tell
    else if actionName is "notes" then
        set sourcePath to item 2 of argv
        set slideNumber to (item 3 of argv) as integer
        set {targetPres, openedByPdm} to my openPresentation(sourcePath)
        set noteText to ""
        tell application "Microsoft PowerPoint"
            repeat with noteShape in shapes of notes page of slide slideNumber of targetPres
                try
                    if has text frame of noteShape then
                        if has text of text frame of noteShape then
                            set noteText to noteText & (content of text range of text frame of noteShape) & return
                        end if
                    end if
                end try
            end repeat
            if openedByPdm then close targetPres
        end tell
        if openedByPdm then my hidePowerPointWhenIdle()
        return noteText
    end if
    error "Unknown PowerPoint action"
end run
