<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $wmPath = __DIR__ . '/offer-assets/watermark_faded.png';
        if (file_exists($wmPath)) {
            $this->SetAlpha(1);
            $this->Image($wmPath, 0, 0, 210, 297, 'PNG', '', '', false, 300);
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
$pdf->Write(0, "Test 5 - SetAlpha(1) plus explicit dpi\n");
$pdf->Output('test_watermark5.pdf', 'I');
