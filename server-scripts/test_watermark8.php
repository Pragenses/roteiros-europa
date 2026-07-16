<?php
require_once('tcpdf/tcpdf.php');

class WMTest extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $wmPath = __DIR__ . '/offer-assets/watermark.png';
        if (file_exists($wmPath)) {
            // Save current margin properties directly, zero them, draw, restore
            $oldL = $this->lMargin; $oldR = $this->rMargin;
            $oldT = $this->tMargin; $oldB = $this->bMargin;
            $this->lMargin = 0; $this->rMargin = 0;
            $this->tMargin = 0; $this->bMargin = 0;
            $this->SetAlpha(0.4);
            $this->Image($wmPath, 0, 0, 210, 297, 'PNG');
            $this->SetAlpha(1);
            $this->lMargin = $oldL; $this->rMargin = $oldR;
            $this->tMargin = $oldT; $this->bMargin = $oldB;
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
$pdf->Write(0, "Test 8 - direct property manipulation for margins\n");
$pdf->Output('test_watermark8.pdf', 'I');
