<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");
header("Content-Type: application/json");
if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") { exit(0); }
if ($_SERVER["REQUEST_METHOD"] !== "POST") { echo json_encode(array("error" => "Method not allowed")); exit; }
$data = json_decode(file_get_contents("php://input"), true);
$subject = isset($data["subject"]) ? $data["subject"] : "";
$body = isset($data["body"]) ? $data["body"] : "";
$body = str_replace("\n", " ", $body);
$body = str_replace("\r", "", $body);
if (!$subject || !$body) { echo json_encode(array("error" => "Missing fields")); exit; }
$fromKey = isset($data["from"]) ? $data["from"] : "grupos";
if ($fromKey === "reservas3") {
  $authUser = "reservas3@tour-pragenses.com";
  $authPass = "FilipDlask24";
  $fromEmail = "reservas3@tour-pragenses.com";
  $fromLabel = "Reservas Tour Pragenses";
} else if ($fromKey === "info") {
  $authUser = "info@tour-pragenses.com";
  $authPass = "Hahaha8144";
  $fromEmail = "info@tour-pragenses.com";
  $fromLabel = "Tour Pragenses";
} else {
  $authUser = "grupos@tour-pragenses.com";
  $authPass = "Hahaha8144";
  $fromEmail = "grupos@tour-pragenses.com";
  $fromLabel = "Group Department Tour Pragenses";
}
function rd($t) { $r=""; while(($l=fgets($t,512))!==false){ $r.=$l; if(substr($l,3,1)==" ") break; } return $r; }
function sr($t,$s){ fputs($t,$s."\r\n"); return rd($t); }
function ok250($r) { return substr($r,0,3) === "250"; }
function makeMessageId($domain) {
  return "<" . bin2hex(random_bytes(16)) . "@" . $domain . ">";
}
function buildEmailData($fromLabel, $fromEmail, $to, $subject, $body) {
  $messageId = makeMessageId("tour-pragenses.com");
  $date = date("r"); // RFC 2822 formatted date
  return "From: " . $fromLabel . " <" . $fromEmail . ">\r\n" .
         "To: " . $to . "\r\n" .
         "Subject: " . $subject . "\r\n" .
         "Date: " . $date . "\r\n" .
         "Message-ID: " . $messageId . "\r\n" .
         "MIME-Version: 1.0\r\n" .
         "Content-Type: text/html; charset=UTF-8\r\n" .
         "\r\n" . $body . "\r\n.\r\n";
}
$t = stream_socket_client("ssl://smtp.svethostingu.cz:465", $errno, $errstr, 30);
if (!$t) { echo json_encode(array("error" => $errstr)); exit; }
rd($t);
sr($t,"EHLO tour-pragenses.com");
sr($t,"AUTH LOGIN");
sr($t,base64_encode($authUser));
$authResp = sr($t,base64_encode($authPass));
if (substr($authResp,0,3) !== "235") { echo json_encode(array("error" => "AUTH failed: ".trim($authResp))); sr($t,"QUIT"); fclose($t); exit; }
$results = array();
if (isset($data["recipients"]) && is_array($data["recipients"])) {
  foreach ($data["recipients"] as $r) {
    $to = isset($r["email"]) ? $r["email"] : "";
    if (!$to) { $results[] = array("ok" => false, "error" => "no email"); continue; }
    $mf = sr($t,"MAIL FROM:<".$fromEmail.">");
    if (!ok250($mf)) { $results[] = array("ok" => false, "error" => trim($mf)); continue; }
    $rc = sr($t,"RCPT TO:<".$to.">");
    if (!ok250($rc)) { $results[] = array("ok" => false, "error" => trim($rc)); continue; }
    sr($t,"DATA");
    fputs($t, buildEmailData($fromLabel, $fromEmail, $to, $subject, $body));
    $resp = rd($t);
    $results[] = array("ok" => strpos($resp,"250") !== false, "error" => strpos($resp,"250") !== false ? null : trim($resp));
  }
} else {
  $to = isset($data["to"]) ? $data["to"] : "";
  $mf = sr($t,"MAIL FROM:<".$fromEmail.">");
  if (!ok250($mf)) { echo json_encode(array("error" => trim($mf))); sr($t,"QUIT"); fclose($t); exit; }
  $rc = sr($t,"RCPT TO:<".$to.">");
  if (!ok250($rc)) { echo json_encode(array("error" => trim($rc))); sr($t,"QUIT"); fclose($t); exit; }
  sr($t,"DATA");
  fputs($t, buildEmailData($fromLabel, $fromEmail, $to, $subject, $body));
  $resp = rd($t);
  sr($t,"QUIT"); fclose($t);
  if (strpos($resp,"250") !== false) { echo json_encode(array("ok" => true)); } else { echo json_encode(array("error" => trim($resp))); }
  exit;
}
sr($t,"QUIT"); fclose($t);
echo json_encode(array("results" => $results));
