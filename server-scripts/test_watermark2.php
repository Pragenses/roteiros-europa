<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public function Header() {
        $wmPath = __DIR__ . '/offer-assets/watermark.png';
        if (file_exists($wmPath)) {
            // No alpha first - just check if image shows at all
            $this->Image($wmPath, 30, 100, 150, 100, 'PNG');
        } else {
            $this->SetFont('helvetica', 'B', 16);
            $this->SetXY(20, 100);
            $this->Cell(0, 10, 'FILE NOT FOUND: ' . $wmPath, 0, 1);
        }
    }
}
$pdf = new WMTest('P', 'mm', 'A4', true, 'UTF-8', false);
$pdf->SetMargins(18, 32, 18);
$pdf->SetAutoPageBreak(true, 25);
$pdf->AddPage();
$pdf->SetFont('helvetica', '', 12);
$pdf->Write(0, "Test 2 - no alpha, fixed position\n");
$pdf->Output('test_watermark2.pdf', 'I');
