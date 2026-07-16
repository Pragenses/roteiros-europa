<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $this->SetFont('helvetica', 'B', 8);
        $this->Write(0, "");
    }
}
$pdf = new WMTest('P', 'mm', 'A4', true, 'UTF-8', false);
$pdf->SetMargins(18, 32, 18);
$pdf->SetHeaderMargin(10);
$pdf->SetFooterMargin(10);
$pdf->SetAutoPageBreak(true, 25);
$pdf->showHeader = true;
$pdf->AddPage();

// Draw watermark directly in the page body, NOT inside Header()
$wmPath = __DIR__ . '/offer-assets/watermark.png';
if (file_exists($wmPath)) {
    $pdf->SetAlpha(0.4);
    $pdf->Image($wmPath, 0, 0, 210, 297, 'PNG');
    $pdf->SetAlpha(1);
} else {
    $pdf->Write(0, "NOT FOUND\n");
}

$pdf->SetXY(18, 32);
$pdf->SetFont('helvetica', '', 12);
$pdf->Write(0, "Test 10 - watermark drawn in page body, not in Header()\n");
$pdf->Output('test_watermark10.pdf', 'I');
