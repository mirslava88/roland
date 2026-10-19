-- Keynote fallback for PPTX playback when PowerPoint cannot keep a show open.
-- Arguments are passed directly to osascript, never inserted into source text.

on ensureWindowedPlayback()
    try
        tell application "System Events" to tell process "Keynote"
            -- Play is the tenth macOS menu; Window is its fifth item. Using
            -- positions works with both localized and English Keynote menus.
            set windowedItem to menu item 5 of menu 1 of menu bar item 10 of menu bar 1
            if value of attribute "AXMenuItemMarkChar" of windowedItem is "✓" then return
        end tell
    on error errorMessage number errorNumber
        -- A Finder-launched PDM may lack Accessibility permission for
        -- System Events. Keynote remembers its windowed-playback setting;
        -- continue and verify the actual playback window below instead of
        -- rejecting a usable live show.
        if errorNumber is -1719 or errorNumber is -25211 then return
        error errorMessage number errorNumber
    end try
    tell application "Keynote" to activate
    tell application "System Events" to tell process "Keynote"
        set windowedItem to menu item 5 of menu 1 of menu bar item 10 of menu bar 1
        if not enabled of windowedItem then error "Keynote windowed playback is unavailable"
        click windowedItem
    end tell
end ensureWindowedPlayback

on hideDocumentWindow(documentId)
    set editorWindowIds to {}
    tell application "Keynote"
        set documentName to name of document id documentId
        set snapshotWindowIds to id of every window
        repeat with snapshotWindowId in snapshotWindowIds
            try
                set candidateWindow to window id (contents of snapshotWindowId)
                if name of candidateWindow is documentName then
                    set end of editorWindowIds to id of candidateWindow
                    try
                        set visible of candidateWindow to false
                    end try
                end if
            end try
        end repeat
    end tell
    return editorWindowIds
end hideDocumentWindow

on hideWindows(windowIds)
    tell application "Keynote"
        repeat with windowId in windowIds
            try
                set visible of window id (contents of windowId) to false
            end try
        end repeat
    end tell
end hideWindows

on editorWindowIds(documentId)
    set resultIds to {}
    tell application "Keynote"
        set documentName to name of document id documentId
        set snapshotWindowIds to id of every window
        repeat with snapshotWindowId in snapshotWindowIds
            try
                set candidateWindow to window id (contents of snapshotWindowId)
                if name of candidateWindow is documentName then set end of resultIds to id of candidateWindow
            end try
        end repeat
    end tell
    return resultIds
end editorWindowIds

on positionPlayback(documentId, displayX, displayY, displayWidth, displayHeight, knownWindowIds, parkedX, parkedY)
    tell application "Keynote"
        if not playing then error "Keynote slideshow is no longer playing"
        set documentName to name of document id documentId
        set playbackWindow to missing value
        repeat 30 times
            set bestArea to displayWidth * displayHeight * 4
            set snapshotWindowIds to id of every window
            repeat with snapshotWindowId in snapshotWindowIds
                try
                    set candidateWindow to window id (contents of snapshotWindowId)
                    set candidateId to id of candidateWindow
                    if visible of candidateWindow and name of candidateWindow is documentName and ¬
                        (knownWindowIds is missing value or knownWindowIds does not contain candidateId) then
                        set candidateBounds to bounds of candidateWindow
                        set candidateArea to ((item 3 of candidateBounds) - (item 1 of candidateBounds)) * ((item 4 of candidateBounds) - (item 2 of candidateBounds))
                        -- Keynote may initially give both the slide and presenter
                        -- windows the document title. The slide window is smaller.
                        if candidateArea > 0 and candidateArea < bestArea then
                            set playbackWindow to candidateWindow
                            set bestArea to candidateArea
                        end if
                    end if
                end try
            end repeat
            if playbackWindow is missing value and knownWindowIds is not missing value then
                set snapshotWindowIds to id of every window
                repeat with snapshotWindowId in snapshotWindowIds
                    try
                        set candidateWindow to window id (contents of snapshotWindowId)
                        if visible of candidateWindow and name of candidateWindow is documentName then
                            set candidateBounds to bounds of candidateWindow
                            set candidateArea to ((item 3 of candidateBounds) - (item 1 of candidateBounds)) * ((item 4 of candidateBounds) - (item 2 of candidateBounds))
                            if candidateArea > 0 and candidateArea < bestArea then
                                set playbackWindow to candidateWindow
                                set bestArea to candidateArea
                            end if
                        end if
                    end try
                end repeat
            end if
            if playbackWindow is not missing value then exit repeat
            delay 0.05
        end repeat
        if playbackWindow is missing value then error "Keynote playback window was not found"
        set playbackWindowId to id of playbackWindow
        -- Keep one pixel on the operator display so Chromium can capture the
        -- complete window while Keynote's player stays out of the desktop.
        -- Place and size it in one step; placing it on-screen first makes a
        -- visible full-size Keynote window flash over PDM during every take.
        set bounds of playbackWindow to {parkedX, parkedY, parkedX + displayWidth, parkedY + displayHeight}
        set actualBounds to bounds of playbackWindow
        if ((item 3 of actualBounds) - (item 1 of actualBounds)) < displayWidth - 1 or ¬
            ((item 4 of actualBounds) - (item 2 of actualBounds)) < displayHeight - 1 then
            -- AppKit can constrain the first resize to the old screen before
            -- moving the window. Repeat on the new rendering screen.
            delay 0.1
            set bounds of playbackWindow to {parkedX, parkedY, parkedX + displayWidth, parkedY + displayHeight}
        end if
        if knownWindowIds is not missing value then
            set snapshotWindowIds to id of every window
            repeat with snapshotWindowId in snapshotWindowIds
                try
                    set candidateWindow to window id (contents of snapshotWindowId)
                    set candidateId to id of candidateWindow
                    if candidateId is not playbackWindowId and ¬
                        knownWindowIds does not contain candidateId and visible of candidateWindow then
                        set candidateBounds to bounds of candidateWindow
                        set candidateArea to ((item 3 of candidateBounds) - (item 1 of candidateBounds)) * ((item 4 of candidateBounds) - (item 2 of candidateBounds))
                        if candidateArea > (displayWidth * displayHeight div 4) then
                            try
                                set visible of candidateWindow to false
                            end try
                        end if
                    end if
                end try
            end repeat
        end if
        return playbackWindowId
    end tell
end positionPlayback

on importDocument(sourcePath, expectedName)
    -- Start Keynote hidden before the first Apple Event; addressing an
    -- unopened application directly can launch its start window visibly.
    try
        do shell script "/usr/bin/pgrep -x Keynote >/dev/null"
    on error
        do shell script "/usr/bin/open -gj -a " & quoted form of "Keynote"
    end try
    tell application "Keynote"
        if playing then error "PDM_KEYNOTE_BUSY"
        -- After an interrupted PDM session its immutable native copy may
        -- already be open. Reuse only the exact file, never a title match.
        if sourcePath ends with ".key" then
            repeat with candidateDocument in every document
                try
                    if POSIX path of (file of candidateDocument) is sourcePath then return id of candidateDocument
                end try
            end repeat
        end if
    end tell
    tell application "Keynote" to set previousIds to id of every document
    tell application "Keynote" to set previousWindowIds to id of every window
    tell application "Keynote"
        set canOpenHidden to not playing
        set snapshotWindowIds to id of every window
        repeat with snapshotWindowId in snapshotWindowIds
            try
                set candidateWindow to window id (contents of snapshotWindowId)
                if visible of candidateWindow and not miniaturized of candidateWindow then set canOpenHidden to false
            end try
        end repeat
    end tell
    -- Launch Services supplies the sandbox file permission that a direct
    -- AppleScript open lacks for a new PPTX. Keep PDM-owned imports hidden;
    -- do not hide Keynote when its user-visible windows are already open.
    if canOpenHidden then
        set openFlags to "-gj"
    else
        set openFlags to "-g"
    end if
    do shell script "/usr/bin/open " & openFlags & " -a " & quoted form of "Keynote" & " " & quoted form of sourcePath
    set targetDocument to missing value
    repeat 150 times
        tell application "Keynote"
            set snapshotWindowIds to id of every window
            repeat with snapshotWindowId in snapshotWindowIds
                try
                    set candidateWindow to window id (contents of snapshotWindowId)
                    set candidateWindowId to id of candidateWindow
                    set candidateWindowName to name of candidateWindow
                    if candidateWindowId > 0 and previousWindowIds does not contain candidateWindowId and ¬
                        (candidateWindowName is expectedName or candidateWindowName is expectedName & ".key" or candidateWindowName starts with expectedName & " ") then
                        try
                            set visible of candidateWindow to false
                        end try
                    end if
                end try
            end repeat
            repeat with candidateDocument in every document
                set candidateId to id of candidateDocument
                set candidateName to name of candidateDocument
                if previousIds does not contain candidateId and ¬
                    (candidateName is expectedName or candidateName is expectedName & ".key" or candidateName starts with expectedName & " ") then
                    set targetDocument to candidateDocument
                    exit repeat
                end if
            end repeat
        end tell
        if targetDocument is not missing value then exit repeat
        delay 0.1
    end repeat
    if targetDocument is missing value then error "Keynote did not import the requested presentation"
    tell application "Keynote"
        set documentId to id of targetDocument
        set importedName to name of targetDocument
    end tell
    -- The document becomes scriptable before its editor is a real window.
    -- Hiding the id -1 placeholder can prevent that window being created.
    set editorReady to false
    repeat 100 times
        tell application "Keynote"
            set snapshotWindowIds to id of every window
            repeat with snapshotWindowId in snapshotWindowIds
                try
                    set candidateWindow to window id (contents of snapshotWindowId)
                    if name of candidateWindow is importedName and id of candidateWindow > 0 then
                        set editorReady to true
                        exit repeat
                    end if
                end try
            end repeat
        end tell
        if editorReady then exit repeat
        delay 0.1
    end repeat
    if not editorReady then
        tell application "Keynote" to close document id documentId saving no
        error "Keynote did not create the imported document window"
    end if
    my hideDocumentWindow(documentId)
    if canOpenHidden then
        -- File imports can unhide Keynote despite Launch Services' -j flag.
        -- Existing windows were already hidden, so this only conceals
        -- PDM's background preparation.
        try
            tell application "System Events" to set visible of process "Keynote" to false
        end try
    end if
    return documentId
end importDocument

on run argv
    if (count of argv) is 0 then error "Keynote action is required"
    set actionName to item 1 of argv
    if actionName is "import-mode" then
        try
            do shell script "/usr/bin/pgrep -x Keynote >/dev/null"
        on error
            do shell script "/usr/bin/open -gj -a " & quoted form of "Keynote"
        end try
        tell application "Keynote"
            if playing then error "PDM_KEYNOTE_BUSY"
            set canHideImport to true
            set snapshotWindowIds to id of every window
            repeat with snapshotWindowId in snapshotWindowIds
                try
                    set candidateWindow to window id (contents of snapshotWindowId)
                    if visible of candidateWindow and not miniaturized of candidateWindow then set canHideImport to false
                end try
            end repeat
        end tell
        if canHideImport then return "hidden"
        return "background"
    else if actionName is "open" then
        set sourcePath to item 2 of argv
        set startSlide to (item 3 of argv) as integer
        set displayX to (item 4 of argv) as integer
        set displayY to (item 5 of argv) as integer
        set displayWidth to (item 6 of argv) as integer
        set displayHeight to (item 7 of argv) as integer
        set expectedName to item 8 of argv
        set parkedX to (item 9 of argv) as integer
        set parkedY to (item 10 of argv) as integer
        set documentId to ""
        try
            set documentId to my importDocument(sourcePath, expectedName)
            tell application "Keynote"
                set targetDocument to document id documentId
                set slideCount to count of slides of targetDocument
                if startSlide < 1 or startSlide > slideCount then error "Slide is outside presentation"
            end tell
            set editorWindowIds to my hideDocumentWindow(documentId)
            do shell script "/usr/bin/open -g -a " & quoted form of "Keynote"
            my ensureWindowedPlayback()
            tell application "Keynote" to set prePlaybackWindowIds to id of every window
            tell application "Keynote"
                set playbackDocument to document id documentId
                start playbackDocument from slide startSlide of playbackDocument
            end tell
            my hideWindows(editorWindowIds)
            set playbackWindowId to my positionPlayback(documentId, displayX, displayY, displayWidth, displayHeight, prePlaybackWindowIds, parkedX, parkedY)
            delay 0.7
            my hideWindows(editorWindowIds)
            tell application "Keynote"
                if not playing then error "Keynote closed its slideshow after launch"
                set visibleSlide to slide number of current slide of document id documentId
            end tell
            if visibleSlide is not startSlide then error "Keynote did not select the requested slide"
            return documentId & tab & (slideCount as text) & tab & (visibleSlide as text) & tab & (playbackWindowId as text)
        on error errorMessage number errorNumber
            if documentId is not "" then
                tell application "Keynote"
                    try
                        stop document id documentId
                    end try
                    try
                        close document id documentId saving no
                    end try
                end tell
            end if
            error errorMessage number errorNumber
        end try
    else if actionName is "prepare" then
        set sourcePath to item 2 of argv
        set expectedName to item 3 of argv
        set documentId to my importDocument(sourcePath, expectedName)
        tell application "Keynote" to set slideCount to count of slides of document id documentId
        return documentId & tab & (slideCount as text)
    else if actionName is "savecache" then
        set documentId to item 2 of argv
        set destinationPath to item 3 of argv
        tell application "Keynote"
            save document id documentId in POSIX file destinationPath
        end tell
        my hideDocumentWindow(documentId)
        return "saved"
    else if actionName is "prepared" then
        set documentId to item 2 of argv
        tell application "Keynote" to set slideCount to count of slides of document id documentId
        return documentId & tab & (slideCount as text)
    else if actionName is "stage" then
        set documentId to item 2 of argv
        set parkedX to (item 3 of argv) as integer
        set parkedY to (item 4 of argv) as integer
        tell application "Keynote"
            set documentName to name of document id documentId
            set editorWindow to first window whose name is documentName
            -- A background import can leave a lazy window with id -1.
            -- Materialize it while Keynote is still hidden, then park it
            -- before the native bridge unhides the application.
            if id of editorWindow < 1 then
                set visible of editorWindow to true
                repeat 30 times
                    set editorWindow to first window whose name is documentName
                    if id of editorWindow > 0 then exit repeat
                    delay 0.1
                end repeat
            end if
            set bounds of editorWindow to {parkedX, parkedY, parkedX + 1280, parkedY + 720}
            set miniaturized of editorWindow to false
            set visible of editorWindow to true
            set index of editorWindow to 1
            delay 0.15
            return id of editorWindow as text
        end tell
    else if actionName is "resume" then
        set documentId to item 2 of argv
        set startSlide to (item 3 of argv) as integer
        set displayX to (item 4 of argv) as integer
        set displayY to (item 5 of argv) as integer
        set displayWidth to (item 6 of argv) as integer
        set displayHeight to (item 7 of argv) as integer
        set parkedX to (item 8 of argv) as integer
        set parkedY to (item 9 of argv) as integer
        tell application "Keynote"
            set targetDocument to document id documentId
            set slideCount to count of slides of targetDocument
            if startSlide < 1 or startSlide > slideCount then error "Slide is outside presentation"
            try
                stop targetDocument
            end try
        end tell
        -- The native PDM accessibility bridge has selected this exact editor
        -- and verified its windowed setting. Keep it as Keynote's main window
        -- until START so a different document cannot supply the playback mode.
        set editorWindowIds to my editorWindowIds(documentId)
        tell application "Keynote" to set prePlaybackWindowIds to id of every window
        tell application "Keynote"
            start targetDocument from slide startSlide of targetDocument
        end tell
        my hideWindows(editorWindowIds)
        set playbackWindowId to my positionPlayback(documentId, displayX, displayY, displayWidth, displayHeight, prePlaybackWindowIds, parkedX, parkedY)
        delay 0.4
        my hideWindows(editorWindowIds)
        tell application "Keynote"
            if not playing then error "Keynote closed its slideshow after resume"
            set visibleSlide to slide number of current slide of document id documentId
        end tell
        return documentId & tab & (slideCount as text) & tab & (visibleSlide as text) & tab & (playbackWindowId as text)
    else if actionName is "refresh" then
        set playbackId to (item 2 of argv) as integer
        tell application "Keynote"
            set originalBounds to bounds of window id playbackId
            try
                set bounds of window id playbackId to {item 1 of originalBounds, item 2 of originalBounds, (item 3 of originalBounds) + 2, (item 4 of originalBounds) + 2}
                delay 0.15
            end try
            set bounds of window id playbackId to originalBounds
        end tell
        return "ok"
    else if actionName is "stop" then
        set documentId to item 2 of argv
        tell application "Keynote"
            if exists document id documentId then
                try
                    stop document id documentId
                end try
            end if
        end tell
        try
            my hideDocumentWindow(documentId)
        end try
        return "ok"
    else if actionName is "close" then
        set documentId to item 2 of argv
        tell application "Keynote"
            if exists document id documentId then
                try
                    stop document id documentId
                end try
                close document id documentId saving no
            end if
        end tell
        return "ok"
    else if actionName is "next" or actionName is "prev" or actionName is "goto" or actionName is "current" then
        set documentId to item 2 of argv
        tell application "Keynote"
            set targetDocument to document id documentId
            if not playing then error "Keynote slideshow is no longer playing"
            if actionName is "next" then
                show next
            else if actionName is "prev" then
                show previous
            else if actionName is "goto" then
                set slideNumber to (item 3 of argv) as integer
                set current slide of targetDocument to slide slideNumber of targetDocument
            end if
            return slide number of current slide of targetDocument
        end tell
    else if actionName is "relocate" then
        set documentId to item 2 of argv
        set displayX to (item 3 of argv) as integer
        set displayY to (item 4 of argv) as integer
        set displayWidth to (item 5 of argv) as integer
        set displayHeight to (item 6 of argv) as integer
        set parkedX to (item 7 of argv) as integer
        set parkedY to (item 8 of argv) as integer
        my positionPlayback(documentId, displayX, displayY, displayWidth, displayHeight, missing value, parkedX, parkedY)
        return "ok"
    else if actionName is "notes" then
        set documentId to item 2 of argv
        set slideNumber to (item 3 of argv) as integer
        tell application "Keynote"
            return presenter notes of slide slideNumber of document id documentId as text
        end tell
    end if
    error "Unknown Keynote action"
end run
