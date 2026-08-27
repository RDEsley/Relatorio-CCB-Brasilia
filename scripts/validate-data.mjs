import { readFile } from "node:fs/promises";

const data = JSON.parse(await readFile(new URL("../data/churches.json", import.meta.url), "utf8"));
const OFFICIAL_REPORT = "https://congregacaocristanobrasil.org.br/relatorio";
const allowedDays = new Set(["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]);
const errors = [];
const ids = new Set();

function fail(id, message) {
  errors.push(`${id}: ${message}`);
}

for (const church of data.churches) {
  if (ids.has(church.id)) fail(church.id, "código duplicado");
  ids.add(church.id);
  if (!/^BR-(07|24)-\d{4}$/.test(church.id)) fail(church.id, "código fora do escopo GO/DF");
  if (!Number.isInteger(church.officialId)) fail(church.id, "identificador oficial ausente");
  if (church.sourceUrl !== OFFICIAL_REPORT) fail(church.id, "fonte não oficial");
  if (!church.officialVerification) fail(church.id, "data de conferência ausente");
  if (church.state !== "DF" && !(church.state === "GO" && church.city === "Águas Lindas de Goiás")) fail(church.id, "cidade fora do escopo");
  if (!church.services.length || church.services.some((service) => !allowedDays.has(service.day) || !/^\d{2}:\d{2}$/.test(service.time))) fail(church.id, "agenda inválida");
  if (church.coordinateStatus === "source-reported") {
    if (!Number.isFinite(church.latitude) || !Number.isFinite(church.longitude)) fail(church.id, "coordenadas reportadas ausentes");
    if (church.latitude < -16.5 || church.latitude > -15.2 || church.longitude < -49.1 || church.longitude > -47.1) fail(church.id, "coordenadas fora da região atendida");
  } else if (church.coordinateStatus !== "unavailable" || church.latitude !== null || church.longitude !== null) {
    fail(church.id, "estado de coordenadas inválido");
  }
  if (!church.routeQuery.startsWith("Congregação Cristã no Brasil - ")) fail(church.id, "rota sem identificação explícita da CCB");

  try {
    const maps = new URL(church.googleMapsUrl);
    if (maps.hostname !== "www.google.com" || maps.pathname !== "/maps/dir/" || maps.searchParams.get("destination") !== church.routeQuery) fail(church.id, "link do Google Maps divergente");
  } catch { fail(church.id, "link do Google Maps inválido"); }

  try {
    const waze = new URL(church.wazeUrl);
    if (waze.hostname !== "waze.com" || waze.pathname !== "/ul" || waze.searchParams.get("q") !== church.routeQuery || waze.searchParams.get("navigate") !== "yes") fail(church.id, "link do Waze divergente");
  } catch { fail(church.id, "link do Waze inválido"); }
}

if (data.officialTotal !== data.churches.length || data.churches.length < 137) fail("BASE", `quantidade oficial inconsistente: ${data.churches.length}`);
if (Object.keys(data.cityCounts ?? {}).length !== 24) fail("BASE", "cobertura de cidades incompleta");
if (data.cityCounts?.["Brazlândia"] !== 7) fail("Brazlândia", `quantidade divergente: ${data.cityCounts?.["Brazlândia"] ?? 0}`);
if (data.cityCounts?.["Águas Lindas de Goiás"] !== 16) fail("Águas Lindas de Goiás", `quantidade divergente: ${data.cityCounts?.["Águas Lindas de Goiás"] ?? 0}`);
if (errors.length) throw new Error(`Validação reprovada:\n${errors.join("\n")}`);
console.log(`${data.churches.length} casas validadas: códigos, escopo, fonte oficial, agenda, coordenadas e rotas.`);

if (process.argv.includes("--network")) {
  const links = data.churches.flatMap((church) => [
    { id: church.id, provider: "Google Maps", url: church.googleMapsUrl },
    { id: church.id, provider: "Waze", url: church.wazeUrl },
  ]);
  const networkErrors = [];
  for (let index = 0; index < links.length; index += 8) {
    const batch = links.slice(index, index + 8);
    await Promise.all(batch.map(async (link) => {
      try {
        const response = await fetch(link.url, { method: "HEAD", redirect: "manual" });
        if (response.status < 200 || response.status >= 400) networkErrors.push(`${link.id}: ${link.provider} respondeu ${response.status}`);
      } catch (error) {
        networkErrors.push(`${link.id}: ${link.provider} indisponível (${error instanceof Error ? error.message : "erro de rede"})`);
      }
    }));
  }
  if (networkErrors.length) throw new Error(`Links inacessíveis:\n${networkErrors.join("\n")}`);
  console.log(`${links.length} links de navegação responderam corretamente.`);
}
