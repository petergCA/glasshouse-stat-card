#!/bin/zsh
# Run on the Mac from the copied repo root (e.g. /tmp/ghstat): renders the harness headless.
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
D=${0:A:h}
"$CH" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=3000 --screenshot=$D/desktop.png --window-size=1232,1900 "file://$D/harness.html" 2>/dev/null
"$CH" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=3000 --screenshot=$D/phone.png --window-size=390,3400 "file://$D/harness.html?w=390" 2>/dev/null
"$CH" --headless=new --disable-gpu --virtual-time-budget=3000 --dump-dom "file://$D/harness.html" 2>/dev/null | grep -o '<title>[^<]*</title>'
