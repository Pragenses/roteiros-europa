<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $wmPath = __DIR__ . '/offer-assets/watermark.png';
        if (file_exists($wmPath)) {
            $this->SetAlpha(0.4);
            // Overshoot past the page edges on all sides to compensate for any internal clipping
            $this->Image($wmPath, -15, -15, 240, 327, 'PNG');
            $this->SetAlpha(1);
        }
    }
}
$pdf = new WMTest('P', 'mm', 'A4', true, 'UTF-8', false);
$pdf->SetMargins(18, 32, 18);
$pdf->SetHeaderMargin(10);
$pdf->SetFooterMargin(10);
$pdf->SetAutoPageBreak(true, 25);
$pdf->showHeader = true;
$pdf->AddPage();
$pdf->SetFont('helvetica', '', 12);
$pdf->Write(0, "Test 9 - overshoot past page edges\n");
$pdf->Output('test_watermark9.pdf', 'I');
