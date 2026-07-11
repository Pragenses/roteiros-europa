<?php
require_once('tcpdf/tcpdf.php');
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");
if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") { exit(0); }
if ($_SERVER["REQUEST_METHOD"] !== "POST") { http_response_code(405); exit; }

$raw = file_get_contents("php://input");
$data = json_decode($raw, true);
if (!$data) { http_response_code(400); echo json_encode(array("error" => "No data: " . json_last_error_msg())); exit; }

class OfferPDF extends TCPDF {
    public $showHeader = false;
    public function Header() {
        if (!$this->showHeader) return;
        $this->SetFont('helvetica', 'B', 8);
        $this->SetTextColor(34, 34, 34);
        $this->SetXY(18, 10);
        $this->Cell(0, 4, 'TOUR PRAGENSES', 0, 1, 'L');
        $this->SetFont('helvetica', '', 7);
        $this->SetTextColor(85, 85, 85);
        $this->SetX(18);
        $this->Cell(0, 4, 'www.tour-pragenses.com', 0, 1, 'L');
        $this->SetX(18);
        $this->Cell(0, 4, '+420 777 079 997', 0, 1, 'L');
        $this->SetX(18);
        $this->Cell(0, 4, 'info@tour-pragenses.com', 0, 0, 'L');
        // Logo top-right
        $logoPath = __DIR__ . '/offer-assets/logo.png';
        if (file_exists($logoPath)) {
            $this->Image($logoPath, 165, 9, 27, 0, 'PNG');
        }
        $this->SetLineStyle(array('width' => 0.2, 'color' => array(220,220,220)));
        $this->Line(18, 26, 192, 26);
    }
    public function Footer() {
        if (!$this->showHeader) return;
        $this->SetY(-15);
        $this->SetLineStyle(array('width' => 0.2, 'color' => array(220,220,220)));
        $this->Line(18, $this->GetY(), 192, $this->GetY());
        $this->SetFont('helvetica', '', 7);
        $this->SetTextColor(85, 85, 85);
        $this->SetY(-12);
        $this->Cell(0, 10, 'Pragenses s.r.o. | Lipnicka 688, Praha 9 - Kyje, Czech Republic | ICO: 284 45 961 | DIC: CZ284 45 961', 0, 0, 'C');
    }
}

function fmt_date($d) {
    if (!$d) return '';
    $parts = explode('-', $d);
    if (count($parts) === 3) return $parts[2] . '/' . $parts[1] . '/' . $parts[0];
    return $d;
}

function strip_html($html) {
    if (!$html) return '';
    $html = preg_replace('/<br\s*\/?>/i', "\n", $html);
    $html = preg_replace('/<\/p>/i', "\n", $html);
    $html = preg_replace('/<p[^>]*>/i', '', $html);
    $html = preg_replace('/<\/div>/i', "\n", $html);
    $html = preg_replace('/<div[^>]*>/i', '', $html);
    $html = strip_tags($html);
    $html = html_entity_decode($html, ENT_QUOTES, 'UTF-8');
    $html = preg_replace('/\n{3,}/', "\n\n", $html);
    return trim($html);
}

$pdf = new OfferPDF('P', 'mm', 'A4', true, 'UTF-8', false);
$pdf->SetCreator('Roteiros Europa');
$pdf->SetAuthor('Tour Pragenses');
$pdf->setPrintHeader(true);
$pdf->setPrintFooter(true);
$pdf->SetMargins(18, 32, 18);
$pdf->SetHeaderMargin(10);
$pdf->SetFooterMargin(10);
$pdf->SetAutoPageBreak(true, 25);
$pdf->setImageScale(PDF_IMAGE_SCALE_RATIO);
$pdf->SetFont('helvetica', '', 10);

// ---- PAGE 1: Cover (no header/footer) ----
$pdf->showHeader = false;
$pdf->AddPage();
$coverPath = __DIR__ . '/offer-assets/cover.png';
if (file_exists($coverPath)) {
    $pdf->Image($coverPath, 0, 0, 210, 297, 'PNG', '', '', false, 300, '', false, false, 0, 'CBT');
}

// ---- PAGE 2+: Content with header/footer ----
$pdf->showHeader = true;
$pdf->AddPage();

$name = isset($data['name']) ? $data['name'] : '';
$startDate = isset($data['startDate']) ? fmt_date($data['startDate']) : '';
$endDate = isset($data['endDate']) ? fmt_date($data['endDate']) : '';
$destinations = isset($data['destinations']) ? $data['destinations'] : '';
$focType = isset($data['focType']) ? strtoupper($data['focType']) : 'DBL';
$items = isset($data['items']) ? $data['items'] : array();

// Title
$pdf->SetFont('helvetica', 'B', 15);
$pdf->SetTextColor(192, 57, 43);
$pdf->Write(7, $name . "\n");
$pdf->SetFont('helvetica', '', 9);
$pdf->SetTextColor(150, 150, 150);
$genTime = date('d/m/Y, H:i');
$pdf->Write(5, "Proposta elaborada em: $genTime\n");
$pdf->SetTextColor(34, 34, 34);
$pdf->SetFont('helvetica', '', 10);
if ($destinations) { $pdf->SetFont('helvetica', 'B', 10); $pdf->Write(5, "Destinos: "); $pdf->SetFont('helvetica', '', 10); $pdf->Write(5, "$destinations\n"); }
if ($startDate || $endDate) { $pdf->SetFont('helvetica', 'B', 10); $pdf->Write(5, "Periodo: "); $pdf->SetFont('helvetica', '', 10); $pdf->Write(5, "$startDate a $endDate\n"); }
$pdf->Ln(3);

// Hotels
$hotelItems = array_filter($items, function($it) {
    return isset($it['type']) && $it['type'] === 'per_pax' && isset($it['subType']) && $it['subType'] === 'hotel';
});
if (count($hotelItems) > 0) {
    $pdf->SetDrawColor(192, 57, 43);
    $pdf->SetLineWidth(0.5);
    $pdf->Line(18, $pdf->GetY(), 192, $pdf->GetY());
    $pdf->Ln(2);
    $pdf->SetFont('helvetica', 'B', 13);
    $pdf->SetTextColor(192, 57, 43);
    $pdf->Write(7, "Hoteis\n");
    $pdf->Ln(1);
    foreach ($hotelItems as $h) {
        $city = isset($h['city']) ? $h['city'] : '';
        $hname = isset($h['name']) ? $h['name'] : '';
        $df = isset($h['dateFrom']) ? fmt_date($h['dateFrom']) : '';
        $dt = isset($h['dateTo']) ? fmt_date($h['dateTo']) : '';
        $dateStr = $df ? " - $df a $dt" : '';
        $pdf->SetFont('helvetica', '', 10);
        $pdf->SetTextColor(34, 34, 34);
        $pdf->Write(5, "* ");
        $pdf->SetFont('helvetica', 'B', 10);
        $pdf->Write(5, "$city: ");
        $pdf->SetFont('helvetica', '', 10);
        $pdf->Write(5, "$hname$dateStr\n");
    }
    $pdf->Ln(3);
}

// Investimento
$pdf->SetDrawColor(192, 57, 43);
$pdf->Line(18, $pdf->GetY(), 192, $pdf->GetY());
$pdf->Ln(2);
$pdf->SetFont('helvetica', 'B', 13);
$pdf->SetTextColor(192, 57, 43);
$pdf->Write(7, "Investimento\n");
$pdf->Ln(1);
$pdf->SetFont('helvetica', '', 10);
$pdf->SetTextColor(34, 34, 34);
$pdf->MultiCell(0, 5, "Valores por pessoa. Inclui hoteis, taxas municipais, refeicoes e ingressos indicados, transporte e guias durante o roteiro. Pax gratis no quarto $focType.", 0, 'L');
$pdf->Ln(2);

$pricing = isset($data['pricingData']) ? $data['pricingData'] : array();
$splitData = isset($pricing['splitData']) ? $pricing['splitData'] : array();
$singleData = isset($pricing['singleData']) ? $pricing['singleData'] : null;

$curSymbol = array('EUR' => 'EUR', 'CHF' => 'CHF', 'GBP' => 'GBP');

function drawPriceTable($pdf, $label, $symbol, $rows) {
    if ($label) {
        $pdf->SetFont('helvetica', 'B', 11);
        $pdf->SetTextColor(34, 34, 34);
        $pdf->Write(6, "$label\n");
        $pdf->Ln(1);
    }
    $colW = array(58, 58, 58);
    $pdf->SetFont('helvetica', '', 9);
    $pdf->SetTextColor(150, 150, 150);
    $pdf->Cell($colW[0], 6, 'Participantes', 0, 0, 'L');
    $pdf->Cell($colW[1], 6, 'Quarto duplo', 0, 0, 'C');
    $pdf->Cell($colW[2], 6, 'Quarto individual', 0, 1, 'C');
    $pdf->SetDrawColor(220,220,220);
    $pdf->Line(18, $pdf->GetY(), 18 + array_sum($colW), $pdf->GetY());
    foreach ($rows as $r) {
        $pax = isset($r['pax']) ? $r['pax'] : '';
        $dbl = isset($r['finalDbl']) ? $r['finalDbl'] : 0;
        $sngl = isset($r['finalSngl']) ? $r['finalSngl'] : 0;
        $pdf->SetFont('helvetica', '', 10);
        $pdf->SetTextColor(34, 34, 34);
        $pdf->Cell($colW[0], 7, "$pax + 1 cortesia", 0, 0, 'L');
        $pdf->SetFont('helvetica', 'B', 10);
        $pdf->Cell($colW[1], 7, $symbol . ' ' . number_format($dbl, 2), 0, 0, 'C');
        $pdf->Cell($colW[2], 7, $symbol . ' ' . number_format($sngl, 2), 0, 1, 'C');
        $pdf->SetDrawColor(240,240,240);
        $pdf->Line(18, $pdf->GetY(), 18 + array_sum($colW), $pdf->GetY());
    }
    $pdf->Ln(4);
}

if (count($splitData) > 0) {
    foreach ($splitData as $sd) {
        $cur = isset($sd['cur']) ? $sd['cur'] : 'EUR';
        $rows = isset($sd['rows']) ? $sd['rows'] : array();
        $symbol = isset($curSymbol[$cur]) ? $curSymbol[$cur] : $cur;
        drawPriceTable($pdf, "Servicos faturados em $cur", $symbol, $rows);
    }
} elseif ($singleData) {
    $cur = isset($singleData['cur']) ? $singleData['cur'] : 'EUR';
    $rows = isset($singleData['rows']) ? $singleData['rows'] : array();
    $symbol = isset($curSymbol[$cur]) ? $curSymbol[$cur] : $cur;
    drawPriceTable($pdf, '', $symbol, $rows);
}

// ---- Incluido / Nao incluido ----
$included = isset($data['includedLines']) ? array_filter(array_map('trim', explode("\n", $data['includedLines']))) : array();
$notIncluded = isset($data['notIncludedLines']) ? array_filter(array_map('trim', explode("\n", $data['notIncludedLines']))) : array();

if (count($included) > 0 || count($notIncluded) > 0) {
    $pdf->AddPage();
    if (count($included) > 0) {
        $pdf->SetDrawColor(192, 57, 43);
        $pdf->Line(18, $pdf->GetY(), 192, $pdf->GetY());
        $pdf->Ln(2);
        $pdf->SetFont('helvetica', 'B', 13);
        $pdf->SetTextColor(192, 57, 43);
        $pdf->Write(7, "Incluido no preco\n");
        $pdf->Ln(1);
        $pdf->SetFont('helvetica', '', 10);
        $pdf->SetTextColor(34, 34, 34);
        foreach ($included as $line) {
            $pdf->Write(5, "* $line\n");
        }
        $pdf->Ln(3);
    }
    if (count($notIncluded) > 0) {
        $pdf->SetDrawColor(192, 57, 43);
        $pdf->Line(18, $pdf->GetY(), 192, $pdf->GetY());
        $pdf->Ln(2);
        $pdf->SetFont('helvetica', 'B', 13);
        $pdf->SetTextColor(192, 57, 43);
        $pdf->Write(7, "Nao incluido\n");
        $pdf->Ln(1);
        $pdf->SetFont('helvetica', '', 10);
        $pdf->SetTextColor(34, 34, 34);
        foreach ($notIncluded as $line) {
            $pdf->Write(5, "* $line\n");
        }
    }
}

// ---- Roteiro ----
$programHtml = isset($data['programText']) ? $data['programText'] : '';
if ($programHtml) {
    $pdf->AddPage();
    $pdf->SetDrawColor(192, 57, 43);
    $pdf->Line(18, $pdf->GetY(), 192, $pdf->GetY());
    $pdf->Ln(2);
    $pdf->SetFont('helvetica', 'B', 13);
    $pdf->SetTextColor(192, 57, 43);
    $pdf->Write(7, "Roteiro\n");
    $pdf->Ln(1);

    $sections = strpos($programHtml, '<!--PAGE_BREAK-->') !== false
        ? explode('<!--PAGE_BREAK-->', $programHtml)
        : array($programHtml);

    $secCount = count($sections);
    foreach ($sections as $idx => $section) {
        $plain = strip_html($section);
        $lines = array_filter(array_map('trim', explode("\n", $plain)));
        foreach ($lines as $line) {
            $isDay = preg_match('/^(\d{1,2}[°º]?\s*DIA\s*[-–]|\d{1,2}\/\d{2}\/\d{4}|📅)/ui', $line);
            if ($isDay) {
                $pdf->SetFont('helvetica', 'B', 10);
                $pdf->SetTextColor(34, 34, 34);
                $pdf->Ln(2);
                $pdf->MultiCell(0, 5, $line, 0, 'L');
            } else {
                $pdf->SetFont('helvetica', '', 10);
                $pdf->SetTextColor(34, 34, 34);
                $pdf->MultiCell(0, 5, $line, 0, 'L');
            }
        }
        if ($idx < $secCount - 1) {
            $pdf->AddPage();
        }
    }

    $pdf->Ln(6);
    $pdf->SetFont('helvetica', 'B', 11);
    $pdf->SetTextColor(34, 34, 34);
    $w = $pdf->GetPageWidth() - 36;
    $pdf->Cell($w, 6, 'Equipe Tour Pragenses', 0, 1, 'C');
    $pdf->SetFont('helvetica', 'I', 10);
    $pdf->SetTextColor(120, 120, 120);
    $pdf->Cell($w, 6, 'Seu parceiro na Europa.', 0, 1, 'C');
}

$filename = preg_replace('/[^a-zA-Z0-9]/', '_', $name ?: 'oferta') . '.pdf';
$pdf->Output($filename, 'D');
