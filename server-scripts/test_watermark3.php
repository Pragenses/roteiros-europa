<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public function Header() {
        $wmPath = __DIR__ . '/offer-assets/watermark.png';
        if (file_exists($wmPath)) {
            $this->SetAlpha(0.4);
            $this->Image($wmPath, 0, 0, 210, 297, 'PNG');
            $this->SetAlpha(1);
        }
    }
}
$pdf = new WMTest('P', 'mm', 'A4', true, 'UTF-8', false);
$pdf->SetMargins(18, 32, 18);
$pdf->SetAutoPageBreak(true, 25);
$pdf->AddPage();
$pdf->SetFont('helvetica', '', 12);
$pdf->Write(0, "Test 3 - full page, alpha 0.4\n");
$pdf->Output('test_watermark3.pdf', 'I');
