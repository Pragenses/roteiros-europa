<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $wmPath = __DIR__ . '/offer-assets/watermark.png';
        if (file_exists($wmPath)) {
            $pw = $this->getPageWidth();
            $ph = $this->getPageHeight();
            $this->SetAlpha(0.4);
            $this->Image($wmPath, 0, 0, $pw, $ph, 'PNG');
            $this->SetAlpha(1);
        } else {
            $this->Write(0, "NOT FOUND: $wmPath\n");
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
$pdf->Write(0, "Test 6 - original watermark.png, getPageWidth/Height instead of hardcoded 210/297\n");
$pdf->Output('test_watermark6.pdf', 'I');
