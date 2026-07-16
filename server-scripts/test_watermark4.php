<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $wmPath = __DIR__ . '/offer-assets/watermark_faded.png';
        if (file_exists($wmPath)) {
            $this->Image($wmPath, 0, 0, 210, 297, 'PNG');
        } else {
            $this->SetFont('helvetica', 'B', 14);
            $this->Write(0, "FILE NOT FOUND\n");
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
$pdf->Write(0, "Test 4 - exact same class structure as production script\n");
$pdf->Output('test_watermark4.pdf', 'I');
