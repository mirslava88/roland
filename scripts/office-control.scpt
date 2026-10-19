use framework "Foundation"
use scripting additions

on normalizedPath(pathValue)
    try
        if pathValue starts with "/" then return POSIX path of ((POSIX file pathValue) as alias)
        return POSIX path of (pathValue as alias)
    on error
        return pathValue
    end try
end normalizedPath

on findWordDocument(sourcePath)
    set sourceHfs to ((POSIX file sourcePath) as alias) as text
    tell application "Microsoft Word"
        set matches to documents whose full name is sourceHfs
        if (count of matches) > 0 then return item 1 of matches
    end tell
    return missing value
end findWordDocument

on findExcelWorkbook(sourcePath)
    set canonicalPath to my normalizedPath(sourcePath)
    tell application "Microsoft Excel"
        set candidates to get workbooks
        repeat with candidate in candidates
            set candidatePath to (full name of candidate) as text
            if my normalizedPath(candidatePath) is canonicalPath then return contents of candidate
        end repeat
    end tell
    return missing value
end findExcelWorkbook

on resultJSON(owned, originalCaption, originalBounds, windowTitle, windowBounds, contentBounds, failureMessage)
    set jsonObject to current application's NSMutableDictionary's alloc()'s init()
    jsonObject's setObject:owned forKey:"owned"
    jsonObject's setObject:originalCaption forKey:"originalCaption"
    jsonObject's setObject:originalBounds forKey:"originalBounds"
    jsonObject's setObject:windowTitle forKey:"title"
    jsonObject's setObject:windowBounds forKey:"windowBounds"
    jsonObject's setObject:contentBounds forKey:"contentBounds"
    jsonObject's setObject:failureMessage forKey:"error"
    set jsonData to current application's NSJSONSerialization's dataWithJSONObject:jsonObject options:0 |error|:(missing value)
    set jsonText to current application's NSString's alloc()'s initWithData:jsonData encoding:4
    return jsonText as text
end resultJSON

on run argv
    set actionName to item 1 of argv
    set family to item 2 of argv
    set sourcePath to item 3 of argv
    if family is "word" then
        set appName to "Microsoft Word"
    else if family is "excel" then
        set appName to "Microsoft Excel"
    else
        error "Unsupported document type"
    end if
    try
        do shell script "/usr/bin/pgrep -x " & quoted form of appName & " >/dev/null"
    on error
        if actionName is "release" then return "closed"
        do shell script "/usr/bin/open -gj -a " & quoted form of appName
    end try
    if family is "word" then
        set targetDoc to my findWordDocument(sourcePath)
    else if family is "excel" then
        set targetDoc to my findExcelWorkbook(sourcePath)
    end if

    if actionName is "sheets" or actionName is "select-sheet" then
        if family is not "excel" or targetDoc is missing value then error "Excel workbook is not open"
        tell application "Microsoft Excel"
            set availableSheets to sheets of targetDoc whose visible is sheet visible
            set sheetNames to {}
            repeat with availableSheet in availableSheets
                set end of sheetNames to name of availableSheet
            end repeat
            if actionName is "select-sheet" then
                set requestedSheet to item 4 of argv
                if requestedSheet is not in sheetNames then error "The selected sheet is not visible"
                set selectedSheets to sheets of targetDoc whose name is requestedSheet
                activate object (item 1 of selectedSheets)
                return "ok"
            end if
            set activeSheetName to name of active sheet of window 1 of targetDoc
        end tell
        set jsonObject to current application's NSMutableDictionary's alloc()'s init()
        jsonObject's setObject:sheetNames forKey:"sheets"
        jsonObject's setObject:activeSheetName forKey:"activeSheet"
        set jsonData to current application's NSJSONSerialization's dataWithJSONObject:jsonObject options:0 |error|:(missing value)
        return (current application's NSString's alloc()'s initWithData:jsonData encoding:4) as text
    end if

    if actionName is "next" or actionName is "prev" or actionName is "home" then
        if targetDoc is missing value then error "The document is no longer open"
        if family is "word" then
            tell application "Microsoft Word"
                if actionName is "next" then
                    large scroll window 1 of targetDoc down 1
                else if actionName is "prev" then
                    large scroll window 1 of targetDoc up 1
                else
                    -- Word for Mac can ignore vertical percent scrolled.
                    -- Home Key moves the caret and viewport, without editing
                    -- the document or activating Office.
                    home key selection of window 1 of targetDoc move a story item extend by moving
                end if
            end tell
        else
            tell application "Microsoft Excel"
                if actionName is "next" then
                    large scroll window 1 of targetDoc down 1
                else if actionName is "prev" then
                    large scroll window 1 of targetDoc up 1
                else
                    set scroll row of window 1 of targetDoc to 1
                    set scroll column of window 1 of targetDoc to 1
                end if
            end tell
        end if
        return "ok"
    end if

    if actionName is "release" then
        if targetDoc is missing value then return "closed"
        set owned to item 4 of argv is "true"
        set originalCaption to item 5 of argv
        set originalBounds to {(item 6 of argv) as integer, (item 7 of argv) as integer, (item 8 of argv) as integer, (item 9 of argv) as integer}
        -- An operator can edit a document opened by PDM. Preserve those edits
        -- rather than discarding them during a channel switch or shutdown.
        if family is "word" then
            tell application "Microsoft Word"
                if owned and saved of targetDoc then
                    close targetDoc saving no
                    return "closed"
                end if
                set caption of window 1 of targetDoc to originalCaption
                set targetDoc to my findWordDocument(sourcePath)
                set bounds of window 1 of targetDoc to originalBounds
            end tell
        else
            tell application "Microsoft Excel"
                if owned and saved of targetDoc then
                    close targetDoc saving no
                    return "closed"
                end if
                set caption of window 1 of targetDoc to originalCaption
                set targetDoc to my findExcelWorkbook(sourcePath)
                set bounds of window 1 of targetDoc to originalBounds
            end tell
        end if
        return "released"
    end if

    if actionName is not "prepare" then error "Unsupported document action"
    set marker to item 4 of argv
    set targetBounds to {(item 5 of argv) as integer, (item 6 of argv) as integer, (item 7 of argv) as integer, (item 8 of argv) as integer}
    set owned to targetDoc is missing value
    if owned then
        -- Launch Services grants sandboxed Office access to the selected file.
        -- Do not activate Office or enter a macOS fullscreen Space.
        do shell script "/usr/bin/open -gj -a " & quoted form of appName & " " & quoted form of sourcePath
        repeat 200 times
            if family is "word" then
                set targetDoc to my findWordDocument(sourcePath)
            else
                set targetDoc to my findExcelWorkbook(sourcePath)
            end if
            if targetDoc is not missing value then exit repeat
            delay 0.1
        end repeat
    end if
    if targetDoc is missing value then error "Office did not open the requested document"

    if family is "word" then
        tell application "Microsoft Word"
            set targetWindow to window 1 of targetDoc
            set originalCaption to caption of targetWindow
            set originalBounds to bounds of targetWindow
            set caption of targetWindow to marker
            set targetDoc to my findWordDocument(sourcePath)
            set targetWindow to window 1 of targetDoc
            set bounds of targetWindow to targetBounds
            set windowTitle to name of targetWindow
        end tell
    else
        tell application "Microsoft Excel"
            set targetWindow to window 1 of targetDoc
            set originalCaption to caption of targetWindow
            set originalBounds to bounds of targetWindow
            set caption of targetWindow to marker
            set targetDoc to my findExcelWorkbook(sourcePath)
            set targetWindow to window 1 of targetDoc
            set bounds of targetWindow to targetBounds
            set windowTitle to name of targetWindow
        end tell
    end if
    -- PDM reads the editor geometry directly through its own Accessibility
    -- permission. osascript only controls the requested Office document.
    return my resultJSON(owned, originalCaption, originalBounds, windowTitle, {}, {}, "")
end run
