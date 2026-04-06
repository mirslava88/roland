-- AppleScript for controlling PowerPoint on macOS
-- Usage: osascript powerpoint-control.scpt <action> [filePath] [slideNumber]

on run argv
    set action to item 1 of argv

    if action is "open" then
        set filePath to item 2 of argv
        openPresentation(filePath)
    else if action is "close" then
        closePresentation()
    else if action is "next" then
        nextSlide()
    else if action is "prev" then
        previousSlide()
    else if action is "goto" then
        set slideNum to item 2 of argv as integer
        goToSlide(slideNum)
    else if action is "slidecount" then
        getSlideCount()
    else if action is "current" then
        getCurrentSlide()
    end if
end run

on openPresentation(filePath)
    tell application "Microsoft PowerPoint"
        activate
        open filePath
        delay 1
        tell active presentation
            set slideCount to count of slides
        end tell
        -- Start slideshow
        tell application "System Events"
            tell process "Microsoft PowerPoint"
                -- Cmd+Shift+Return to start slideshow from beginning
                keystroke return using {command down, shift down}
            end tell
        end tell
        return "{\"Status\":\"ok\",\"SlideCount\":" & slideCount & ",\"CurrentSlide\":1}"
    end tell
end openPresentation

on closePresentation()
    tell application "Microsoft PowerPoint"
        try
            tell application "System Events"
                tell process "Microsoft PowerPoint"
                    key code 53 -- Escape key
                end tell
            end tell
        end try
        try
            close active presentation saving no
        end try
    end tell
    return "{\"Status\":\"ok\"}"
end closePresentation

on nextSlide()
    tell application "System Events"
        tell process "Microsoft PowerPoint"
            key code 124 -- Right arrow
        end tell
    end tell
    delay 0.1
    tell application "Microsoft PowerPoint"
        try
            set currentSlide to slide number of slide of slide show view of slide show window 1
            return "{\"Status\":\"ok\",\"CurrentSlide\":" & currentSlide & "}"
        on error
            return "{\"Status\":\"error\",\"Message\":\"No active slideshow\"}"
        end try
    end tell
end nextSlide

on previousSlide()
    tell application "System Events"
        tell process "Microsoft PowerPoint"
            key code 123 -- Left arrow
        end tell
    end tell
    delay 0.1
    tell application "Microsoft PowerPoint"
        try
            set currentSlide to slide number of slide of slide show view of slide show window 1
            return "{\"Status\":\"ok\",\"CurrentSlide\":" & currentSlide & "}"
        on error
            return "{\"Status\":\"error\",\"Message\":\"No active slideshow\"}"
        end try
    end tell
end previousSlide

on goToSlide(slideNum)
    tell application "Microsoft PowerPoint"
        try
            tell slide show view of slide show window 1
                go to slide slide slideNum
            end tell
            return "{\"Status\":\"ok\",\"CurrentSlide\":" & slideNum & "}"
        on error
            return "{\"Status\":\"error\",\"Message\":\"No active slideshow\"}"
        end try
    end tell
end goToSlide

on getSlideCount()
    tell application "Microsoft PowerPoint"
        try
            set slideCount to count of slides of active presentation
            return "{\"Status\":\"ok\",\"SlideCount\":" & slideCount & "}"
        on error
            return "{\"Status\":\"error\",\"Message\":\"No active presentation\"}"
        end try
    end tell
end getSlideCount

on getCurrentSlide()
    tell application "Microsoft PowerPoint"
        try
            set currentSlide to slide number of slide of slide show view of slide show window 1
            return "{\"Status\":\"ok\",\"CurrentSlide\":" & currentSlide & "}"
        on error
            return "{\"Status\":\"error\",\"Message\":\"No active slideshow\"}"
        end try
    end tell
end getCurrentSlide
