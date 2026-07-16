<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $wmPath = __DIR__ . '/offer-assets/watermark.png';
        if (file_exists($wmPath)) {
            // Save current margins, zero them out for the watermark draw, then restore
            $oldMargins = $this->getMargins();
            $this->SetMargins(0, 0, 0);
            $this->SetAutoPageBreak(false, 0);
            $this->SetAlpha(0.4);
            $this->Image($wmPath, 0, 0, 210, 297, 'PNG');
            $this->SetAlpha(1);
            $this->SetMargins($oldMargins['left'], $oldMargins['top'], $oldMargins['right']);
            $this->SetAutoPageBreak(true, 25);
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
$pdf->Write(0, "Test 7 - zero margins during watermark draw\n");
$pdf->Output('test_watermark7.pdf', 'I');
