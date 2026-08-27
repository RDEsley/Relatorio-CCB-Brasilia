import { readFile, writeFile } from "node:fs/promises";

const BASE_URL = "https://congregacaocristanobrasil.org.br";
const REPORT_URL = `${BASE_URL}/relatorio`;
const DATA_URL = new URL("../data/churches.json", import.meta.url);
const DAY_NAMES = new Map([
  ["Domingo", "Dom"], ["Segunda-feira", "Seg"], ["Terça-feira", "Ter"],
  ["Quarta-feira", "Qua"], ["Quinta-feira", "Qui"], ["Sexta-feira", "Sex"], ["Sábado", "Sáb"],
]);

function decodeHtml(value = "") {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&nbsp;", " ").replaceAll("&amp;", "&").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function plainText(value = "") {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function cardsFrom(html) {
  return [...html.matchAll(/<div class="card detalhe">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
}

function parseMinistry(card = "") {
  const groups = [];
  let current = null;
  for (const match of card.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const paragraph = match[1];
    const value = plainText(paragraph);
    if (!value) continue;
    if (/<strong/i.test(paragraph)) {
      current = { role: value, names: [] };
      groups.push(current);
    } else if (current) current.names.push(value);
  }
  return groups.filter((group) => group.names.length > 0);
}

function parseServices(card = "") {
  const services = [];
  let currentType = "";
  for (const match of card.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const paragraph = match[1];
    const value = plainText(paragraph);
    if (!value) continue;
    if (/<strong/i.test(paragraph)) {
      if (/Reunião de Jovens e Menores/i.test(value)) currentType = "Reunião de jovens e menores";
      if (/Culto Oficial/i.test(value)) currentType = "Culto oficial";
      continue;
    }
    const schedule = /^(Domingo|Segunda-feira|Terça-feira|Quarta-feira|Quinta-feira|Sexta-feira|Sábado)\s*-\s*(\d{2}:\d{2})/.exec(value);
    if (schedule && currentType) services.push({ day: DAY_NAMES.get(schedule[1]), time: schedule[2], type: currentType });
  }
  return services;
}

function valueAfterLabel(card, label) {
  return plainText(new RegExp(`${label}:?\\s*<\\/strong>\\s*([^<]*)`, "i").exec(card)?.[1] ?? "");
}

function parseDetail(html) {
  const cards = cardsFrom(html);
  const headerCard = cards[0] ?? "";
  const locationCard = cards.find((card) => /Localiza(?:ção|&#231;&#227;o)/i.test(card)) ?? "";
  const serviceCard = cards.find((card) => /Dias de Culto/i.test(card)) ?? "";
  const ministryCard = cards.find((card) => /Minist(?:ério|&#233;rio)/i.test(card)) ?? "";
  const phoneCard = cards.find((card) => /Telefone\(s\)/i.test(card)) ?? "";
  const cityParts = valueAfterLabel(locationCard, "Cidade").split(",").map((part) => part.trim()).filter(Boolean);
  return {
    name: plainText(/<label[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/.exec(headerCard)?.[1] ?? ""),
    isCentral: [...headerCard.matchAll(/<small[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>[\s\S]*?<\/small>/g)]
      .map((match) => plainText(match[1])).includes("CENTRAL"),
    code: [...headerCard.matchAll(/<small[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>[\s\S]*?<\/small>/g)]
      .map((match) => plainText(match[1])).find((value) => /^BR-\d{2}-\d{4}$/.test(value)) ?? "",
    street: valueAfterLabel(locationCard, "Logradouro"),
    postalCode: valueAfterLabel(locationCard, "CEP"),
    city: cityParts[0] ?? "",
    state: cityParts[1] ?? "",
    services: parseServices(serviceCard),
    ministry: parseMinistry(ministryCard),
    phones: [...phoneCard.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((match) => plainText(match[1])).filter(Boolean),
  };
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const isManualRedirect = options?.redirect === "manual" && response.status >= 300 && response.status < 400;
      if (!response.ok && !isManualRedirect) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

async function createOfficialClient() {
  const cookieJar = new Map();
  let response;
  let requestUrl = REPORT_URL;
  for (let redirect = 0; redirect < 5; redirect += 1) {
    response = await fetchWithRetry(requestUrl, {
      redirect: "manual",
      headers: {
        "Cookie": [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
        "User-Agent": "Relatorio-CCB-Brasilia/1.0",
      },
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";", 1);
      const separator = pair.indexOf("=");
      cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (response.status < 300 || response.status >= 400) break;
    requestUrl = new URL(response.headers.get("location"), requestUrl).href;
  }
  if (!response || !response.ok) throw new Error("Não foi possível iniciar uma sessão no relatório oficial.");
  const html = await response.text();
  const token = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html)?.[1];
  const cookies = [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  if (!token) throw new Error("O relatório oficial não forneceu o token de consulta.");
  return async (path, body) => {
    const result = await fetchWithRetry(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "AntiForgeryToken": token,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Cookie": cookies,
        "User-Agent": "Relatorio-CCB-Brasilia/1.0",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams(body),
    });
    return result.text();
  };
}

function parseListingRows(html) {
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].flatMap((match) => {
    const row = match[1];
    const officialId = /data-id="(\d+)"/.exec(row)?.[1];
    const code = /BR-\d{2}-\d{4}/.exec(plainText(row))?.[0];
    return officialId && code ? [{ id: code, officialId: Number(officialId) }] : [];
  });
}

async function listOfficialScope(post) {
  const countries = JSON.parse(await post("/service/pais-relatorio", {})).list;
  const country = countries.find((item) => item.Text === "Brasil");
  if (!country) throw new Error("Brasil não encontrado no relatório oficial.");

  const states = JSON.parse(await post("/service/estado-relatorio", { codigoPais: country.Value })).list;
  const df = states.find((item) => item.Text === "DISTRITO FEDERAL");
  const go = states.find((item) => item.Text === "GOIÁS");
  if (!df || !go) throw new Error("DF ou Goiás não encontrado no relatório oficial.");

  const dfCities = JSON.parse(await post("/service/cidade-relatorio", { codigoEstado: df.Value })).list;
  const goCities = JSON.parse(await post("/service/cidade-relatorio", { codigoEstado: go.Value })).list;
  const aguasLindas = goCities.find((item) => item.Text === "Águas Lindas de Goiás");
  if (!aguasLindas) throw new Error("Águas Lindas de Goiás não encontrada no relatório oficial.");

  const targets = [
    ...dfCities.map((city) => ({ ...city, stateCode: df.Value })),
    { ...aguasLindas, stateCode: go.Value },
  ];
  const records = new Map();

  for (const city of targets) {
    const commonBody = {
      codigoPais: country.Value,
      codigoEstado: city.stateCode,
      codigoCidade: city.Value,
      tipoCulto: "Culto Oficial,Reunião de Jovens e Menores",
      diaSemana: "1,2,3,4,5,6,7",
      periodo: "Manhã,Tarde,Noite",
    };
    const cityRecords = [];
    for (let page = 1; page <= 100; page += 1) {
      const html = await post("/service/servico-relatorio", { ...commonBody, pagina: String(page) });
      const pageRecords = parseListingRows(html);
      cityRecords.push(...pageRecords);
      const hasNextPage = new RegExp(`<button[^>]*value="${page + 1}"[^>]*>`, "i").test(html);
      if (!pageRecords.length || !hasNextPage) break;
    }
    cityRecords.forEach((record) => records.set(record.id, record));
    process.stdout.write(`${city.Text}: ${cityRecords.length} casas encontradas.\n`);
  }

  return [...records.values()];
}

async function loadOfficialChurch(record, existingChurch, post) {
  const church = existingChurch ?? { id: record.id, latitude: null, longitude: null };
  const officialId = record.officialId;
  const detail = parseDetail(await post("/service/localidade-detalhe", { codigo: officialId }));
  if (detail.code !== church.id || !detail.name || !detail.city || !detail.services.length) {
    throw new Error(`${church.id}: detalhes oficiais incompletos ou divergentes: ${JSON.stringify(detail)}`);
  }

  const displayName = `${detail.name}${detail.isCentral ? " - Central" : ""}`;
  const address = `${detail.street || "Endereço não informado"}${detail.postalCode ? `, CEP ${detail.postalCode}` : ""}`;
  const routeQuery = [
    `Congregação Cristã no Brasil - ${displayName}`,
    detail.street,
    detail.city,
    detail.state,
    detail.postalCode,
    "Brasil",
  ].filter(Boolean).join(", ");
  const coordinatesInRegion = Number.isFinite(church.latitude) && Number.isFinite(church.longitude)
    && church.latitude >= -16.5 && church.latitude <= -15.2
    && church.longitude >= -49.1 && church.longitude <= -47.1;
  const coordinatesAvailable = coordinatesInRegion && !church.coordinatePrecision;
  const updated = {
    ...church,
    name: displayName,
    neighborhood: displayName,
    city: detail.city,
    state: detail.state,
    address,
    services: detail.services,
    latitude: coordinatesAvailable ? church.latitude : null,
    longitude: coordinatesAvailable ? church.longitude : null,
    coordinateStatus: coordinatesAvailable ? "source-reported" : "unavailable",
    ministry: detail.ministry,
    phones: detail.phones,
    officialId: Number(officialId),
    routeQuery,
    googleMapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(routeQuery)}`,
    wazeUrl: `https://waze.com/ul?q=${encodeURIComponent(routeQuery)}&navigate=yes`,
    sourceUrl: REPORT_URL,
    officialVerification: new Date().toISOString().slice(0, 10),
  };
  delete updated.mapsUrl;
  delete updated.coordinatePrecision;
  return updated;
}

const current = JSON.parse(await readFile(DATA_URL, "utf8"));
const post = await createOfficialClient();
const officialRecords = await listOfficialScope(post);
const existingById = new Map(current.churches.map((church) => [church.id, church]));
const churches = [];
for (let index = 0; index < officialRecords.length; index += 4) {
  const batch = officialRecords.slice(index, index + 4);
  churches.push(...await Promise.all(batch.map((record) => loadOfficialChurch(record, existingById.get(record.id), post))));
  process.stdout.write(`Verificadas ${churches.length}/${officialRecords.length} casas no relatório oficial.\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

churches.sort((a, b) => a.city.localeCompare(b.city, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"));
const cityCounts = Object.fromEntries([...new Set(churches.map((church) => church.city))]
  .sort((a, b) => a.localeCompare(b, "pt-BR"))
  .map((city) => [city, churches.filter((church) => church.city === city).length]));
await writeFile(DATA_URL, `${JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), officialTotal: churches.length, cityCounts, churches }, null, 2)}\n`);
console.log(`Concluído: ${churches.length} casas confirmadas no relatório oficial.`);
