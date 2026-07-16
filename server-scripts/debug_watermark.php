<?php
$wmPath = __DIR__ . '/offer-assets/watermark_faded.png';
echo "File exists: " . (file_exists($wmPath) ? "YES" : "NO") . "\n";
if (file_exists($wmPath)) {
    echo "File size: " . filesize($wmPath) . " bytes\n";
    $info = getimagesize($wmPath);
    echo "Image dimensions: " . $info[0] . "x" . $info[1] . "\n";
    echo "Image type: " . $info['mime'] . "\n";
}
