-- Dismiss only the Keynote import error for the file currently being opened.
-- Its modal dialog otherwise survives an osascript timeout and blocks every
-- later presentation, including files that Keynote can import.
on run argv
    set expectedFileName to item 1 of argv
    set permittedFileNames to argv
    repeat 100 times
        tell application "System Events" to tell process "Keynote"
            try
                set importDialog to first window whose subrole is "AXDialog"
                set messageText to (value of every static text of importDialog) as text
                if messageText contains "Невозможно импортировать" or messageText contains "Cannot Import" or messageText contains "Unable to Import" then
                    repeat with permittedName in permittedFileNames
                        -- Delimit the name: a.pptx must not match another
                        -- user's presentation named extra.pptx.
                        set fileName to contents of permittedName
                        if messageText contains ("«" & fileName & "»") or ¬
                            messageText contains ("“" & fileName & "”") or ¬
                            messageText contains (quote & fileName & quote) then
                            click button "OK" of importDialog
                            if fileName is expectedFileName then return "dismissed"
                            exit repeat
                        end if
                    end repeat
                end if
            end try
        end tell
        delay 0.2
    end repeat
    return "none"
end run
