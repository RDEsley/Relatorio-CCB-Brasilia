"use client";

import Image from "next/image";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Check,
  ChevronDown,
  Church,
  Crosshair,
  Heart,
  Info,
  LoaderCircle,
  MapPin,
  MapPinned,
  Navigation,
  Plus,
  Phone,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import churchData from "../data/churches.json";

type Service = { day: string; time: string; type: string };
type ChurchItem = (typeof churchData.churches)[number];
type SavedPlace = { id: string; name: string; address: string; latitude: number; longitude: number; accuracy?: number };
type Period = "Todos" | "Manhã" | "Tarde" | "Noite";
type View = "explore" | "favorites" | "archived";
type DistanceStatus = "idle" | "loading" | "ready" | "error";

const MAX_LOCATION_ACCURACY_METERS = 500;

const DAYS = [
  { short: "Dom", long: "Domingo" }, { short: "Seg", long: "Segunda" },
  { short: "Ter", long: "Terça" }, { short: "Qua", long: "Quarta" },
  { short: "Qui", long: "Quinta" }, { short: "Sex", long: "Sexta" },
  { short: "Sáb", long: "Sábado" },
];

const coordinateKey = (latitude: number | null, longitude: number | null) => `${latitude},${longitude}`;
const coordinateCounts = churchData.churches.reduce((counts, church) => {
  if (!Number.isFinite(church.latitude) || !Number.isFinite(church.longitude)) return counts;
  const key = coordinateKey(church.latitude, church.longitude);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}, new Map<string, number>());
const routeDestinations = churchData.churches
  .filter((church) => Number.isFinite(church.latitude)
    && Number.isFinite(church.longitude)
    && coordinateCounts.get(coordinateKey(church.latitude, church.longitude)) === 1)
  .map((church) => ({
    id: church.id,
    latitude: Number(church.latitude),
    longitude: Number(church.longitude),
  }));

const periodFor = (time: string): Exclude<Period, "Todos"> => {
  const hour = Number(time.split(":")[0]);
  return hour < 12 ? "Manhã" : hour < 18 ? "Tarde" : "Noite";
};

const formatDistance = (value: number) => value < 1
  ? `${Math.round(value * 1000)} m`
  : `${value.toFixed(value < 10 ? 1 : 0).replace(".", ",")} km`;

const formatAccuracy = (value: number) => value < 1000
  ? `${Math.round(value)} m`
  : `${(value / 1000).toFixed(1).replace(".", ",")} km`;

const normalizeSearch = (value: string) => value
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("pt-BR")
  .trim();

const googleMapsRouteUrl = (church: ChurchItem, origin: SavedPlace | null) => {
  if (!origin) return church.googleMapsUrl;

  const search = new URLSearchParams({
    api: "1",
    origin: `${origin.latitude},${origin.longitude}`,
    destination: church.routeQuery,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${search}`;
};

const geolocationErrorMessage = (error: GeolocationPositionError) => {
  if (error.code === error.PERMISSION_DENIED) return "Permissão de localização bloqueada. Libere o acesso nas configurações do navegador.";
  if (error.code === error.TIMEOUT) return "A localização demorou para responder. Tente novamente em um local com melhor sinal.";
  return "O aparelho não conseguiu determinar sua localização. Ative a localização precisa ou salve seu endereço.";
};

function useStoredSet(key: string) {
  const [items, setItems] = useState<Set<string>>(new Set());
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { setItems(new Set(JSON.parse(localStorage.getItem(key) || "[]"))); } catch { setItems(new Set()); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [key]);
  const update = (id: string) => setItems((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    localStorage.setItem(key, JSON.stringify([...next]));
    return next;
  });
  const clear = () => { localStorage.setItem(key, "[]"); setItems(new Set()); };
  return { items, update, clear };
}

export default function Home() {
  const today = DAYS[new Date().getDay()].short;
  const [day, setDay] = useState(today);
  const [period, setPeriod] = useState<Period>("Todos");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("explore");
  const [origin, setOrigin] = useState<SavedPlace | null>(null);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [placeAddress, setPlaceAddress] = useState("");
  const [visibleCount, setVisibleCount] = useState(12);
  const [selectedChurch, setSelectedChurch] = useState<ChurchItem | null>(null);
  const [roadDistances, setRoadDistances] = useState<Record<string, number>>({});
  const [distanceStatus, setDistanceStatus] = useState<DistanceStatus>("idle");
  const favorites = useStoredSet("ccb-favorites");
  const archived = useStoredSet("ccb-archived");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setPlaces(JSON.parse(localStorage.getItem("ccb-places") || "[]"));
        const selected = localStorage.getItem("ccb-origin");
        if (selected) {
          const savedOrigin = JSON.parse(selected) as SavedPlace;
          if (savedOrigin.id === "current") {
            localStorage.removeItem("ccb-origin");
          } else {
            setRoadDistances({});
            setDistanceStatus("loading");
            setOrigin(savedOrigin);
          }
        }
        const filters = JSON.parse(localStorage.getItem("ccb-filters") || "null");
        if (filters?.day) setDay(filters.day);
        if (filters?.period) setPeriod(filters.period);
      } catch { /* ignora preferências locais inválidas */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => { localStorage.setItem("ccb-filters", JSON.stringify({ day, period })); }, [day, period]);

  useEffect(() => {
    if (!origin) return;

    const controller = new AbortController();
    fetch("/api/distances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: { latitude: origin.latitude, longitude: origin.longitude },
        destinations: routeDestinations,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Falha ao calcular rotas");
        return response.json() as Promise<{ distances: Record<string, number> }>;
      })
      .then(({ distances }) => {
        setRoadDistances(distances);
        setDistanceStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDistanceStatus("error");
      });

    return () => controller.abort();
  }, [origin]);

  const selectOrigin = (place: SavedPlace, persist = true) => {
    setRoadDistances({});
    setDistanceStatus("loading");
    setOrigin(place);
    if (persist) localStorage.setItem("ccb-origin", JSON.stringify(place));
    else localStorage.removeItem("ccb-origin");
    setLocationOpen(false);
    setLocationError("");
  };

  const useCurrentLocation = () => {
    setLocationError("");
    if (!navigator.geolocation) return setLocationError("Localização indisponível neste navegador.");
    setLocating(true);

    const handlePosition = ({ coords }: GeolocationPosition) => {
      if (coords.accuracy > MAX_LOCATION_ACCURACY_METERS) {
        setLocationError(`A posição recebida está imprecisa (±${formatAccuracy(coords.accuracy)}). Ative a localização precisa ou salve seu endereço.`);
        setLocating(false);
        return;
      }

      selectOrigin({
        id: "current",
        name: "Localização atual",
        address: `Precisão aproximada de ${formatAccuracy(coords.accuracy)}`,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
      }, false);
      setLocating(false);
    };

    const handleFinalError = (error: GeolocationPositionError) => {
      setLocationError(geolocationErrorMessage(error));
      setLocating(false);
    };

    navigator.geolocation.getCurrentPosition(
      handlePosition,
      (error) => {
        if (error.code === error.PERMISSION_DENIED) return handleFinalError(error);
        navigator.geolocation.getCurrentPosition(handlePosition, handleFinalError, {
          enableHighAccuracy: false,
          maximumAge: 60_000,
          timeout: 8_000,
        });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
    );
  };

  const savePlace = async (event: FormEvent) => {
    event.preventDefault();
    setLocating(true);
    setLocationError("");
    try {
      const search = new URLSearchParams({
        format: "jsonv2",
        limit: "1",
        countrycodes: "br",
        bounded: "1",
        viewbox: "-49.1,-15.2,-47.1,-16.5",
        q: `${placeAddress}, Brasil`,
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${search}`);
      const [result] = await response.json();
      if (!result) throw new Error();
      const place = { id: crypto.randomUUID(), name: placeName.trim(), address: result.display_name || placeAddress.trim(), latitude: Number(result.lat), longitude: Number(result.lon) };
      const next = [...places, place];
      setPlaces(next);
      localStorage.setItem("ccb-places", JSON.stringify(next));
      setPlaceName(""); setPlaceAddress(""); selectOrigin(place);
    } catch { setLocationError("Endereço não encontrado. Tente incluir bairro e cidade."); }
    finally { setLocating(false); }
  };

  const removePlace = (id: string) => {
    const next = places.filter((place) => place.id !== id);
    setPlaces(next);
    localStorage.setItem("ccb-places", JSON.stringify(next));
  };

  const results = useMemo(() => churchData.churches
    .map((church) => ({
      church,
      matching: church.services.filter((service) => service.day === day && (period === "Todos" || periodFor(service.time) === period)),
      distance: origin && distanceStatus === "ready" ? roadDistances[church.id] ?? null : null,
    }))
    .filter(({ church, matching }) => {
      const words = normalizeSearch(`${church.name} ${church.neighborhood} ${church.city} ${church.address}`);
      const searchTerms = normalizeSearch(query).split(/\s+/).filter(Boolean);
      const inView = view === "favorites" ? favorites.items.has(church.id) : view === "archived" ? archived.items.has(church.id) : !archived.items.has(church.id);
      return matching.length && inView && searchTerms.every((term) => words.includes(term));
    })
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.church.name.localeCompare(b.church.name, "pt-BR")),
  [day, period, origin, query, view, favorites.items, archived.items, roadDistances, distanceStatus]);

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top">
        <span className="brand-mark"><Image src="/favicons/favicon-128x128.png" alt="" width={34} height={34} priority /></span>
        <b>Casas de Oração</b>
      </a>
      <nav className="nav-links" aria-label="Seções">
        <button className={view === "explore" ? "active" : ""} onClick={() => setView("explore")}>Buscar</button>
        <button className={view === "favorites" ? "active" : ""} onClick={() => setView("favorites")}><Star size={15} /> Favoritos</button>
        <button className={view === "archived" ? "active" : ""} onClick={() => setView("archived")}><Archive size={15} /> Arquivados</button>
      </nav>
    </header>

    <section className="hero" id="top">
      <h1>Onde congregar?</h1>
      <p>Brasília, Distrito Federal e Águas Lindas de Goiás.</p>

      <div className="finder-card">
        <button className={origin ? "origin-picker selected" : "origin-picker attention"} onClick={() => setLocationOpen(true)}>
          <MapPin size={18} />
          <span><b>{origin?.name || "Escolha sua localização de saída"}</b>{origin && <small>{origin.address}</small>}</span>
          <ChevronDown size={17} />
        </button>

        <div className="filter-row">
          <div className="day-chips" aria-label="Dia da semana">
            {DAYS.map((item) => <button key={item.short} className={day === item.short ? "active" : ""} onClick={() => { setDay(item.short); setVisibleCount(12); }} title={item.long}>
              <span>{item.short}</span>
              {item.short === today && <i>Hoje</i>}
            </button>)}
          </div>
          <div className="period-chips" aria-label="Período">
            {(["Todos", "Manhã", "Tarde", "Noite"] as Period[]).map((item) => <button key={item} className={period === item ? "active" : ""} onClick={() => { setPeriod(item); setVisibleCount(12); }}>{item}</button>)}
          </div>
          <div className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(12); }} placeholder="Buscar local" aria-label="Buscar casa de oração" />{query && <button onClick={() => setQuery("")}><X size={15} /></button>}</div>
        </div>
      </div>
    </section>

    <section className="results-section">
      <div className="results-toolbar">
        <div><h2>{results.length} de {churchData.churches.length} casas</h2><p>{DAYS.find((item) => item.short === day)?.long} · {period === "Todos" ? "todos os períodos" : period}{distanceStatus === "loading" ? " · calculando rotas" : distanceStatus === "ready" ? " · por distância de carro" : distanceStatus === "error" ? " · distâncias indisponíveis" : ""}</p></div>
        {view === "archived" && archived.items.size > 0 && <button className="restore-all" onClick={archived.clear}><ArchiveRestore size={16} /> Desarquivar todas</button>}
      </div>

      {results.length ? <>
        <div className="church-grid">
          {results.slice(0, visibleCount).map(({ church, matching, distance }, index) => <article className="church-card" key={church.id} tabIndex={0} onClick={() => setSelectedChurch(church)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) setSelectedChurch(church); }}>
            <div className="card-top">
              <div className="distance-badge"><Navigation size={14} fill="currentColor" />{distance !== null ? formatDistance(distance) : distanceStatus === "loading" ? "Calculando rota" : origin ? "Distância indisponível" : "Selecione uma localização"}</div>
              <div className="card-tools" onClick={(event) => event.stopPropagation()}>
                <button className={favorites.items.has(church.id) ? "favorited" : ""} onClick={() => favorites.update(church.id)} aria-label="Favoritar"><Star size={19} fill={favorites.items.has(church.id) ? "currentColor" : "none"} /></button>
                <button onClick={() => archived.update(church.id)} aria-label={archived.items.has(church.id) ? "Desarquivar" : "Arquivar"}>{archived.items.has(church.id) ? <ArchiveRestore size={19} /> : <Archive size={19} />}</button>
              </div>
            </div>
            <div className="card-heading"><span className="card-index">{String(index + 1).padStart(2, "0")}</span><div><h3>{church.name}</h3><p>{church.city} · {church.state}</p></div></div>
            <div className="address"><MapPinned size={18} /><span>{church.address}<small>{church.neighborhood !== church.name && church.neighborhood}</small></span></div>
              <div className="service-list">
              {matching.map((service: Service, serviceIndex: number) => <div className="service-row" key={`${service.type}-${service.time}-${serviceIndex}`}>
                <span className={service.type.includes("jovens") ? "service-icon youth" : "service-icon"}>{service.type.includes("jovens") ? <Heart size={17} /> : <Church size={17} />}</span>
                <div><small>{service.type}</small><b>{service.time}</b></div>
                <span className="period-tag">{periodFor(service.time)}</span>
              </div>)}
              </div>
            <div className="route-actions" onClick={(event) => event.stopPropagation()}>
              <a className="maps-button" href={googleMapsRouteUrl(church, origin)} target="_blank" rel="noreferrer"><MapPin size={18} /> Google Maps <ArrowUpRight size={15} /></a>
              <a className="waze-button" href={church.wazeUrl} target="_blank" rel="noreferrer"><Navigation size={18} fill="currentColor" /> Waze <ArrowUpRight size={15} /></a>
            </div>
          </article>)}
        </div>
        {visibleCount < results.length && <button className="load-more" onClick={() => setVisibleCount((count) => count + 12)}>Mostrar mais</button>}
      </> : <div className="empty-state"><Church size={30} /><h3>Nenhuma casa encontrada</h3><p>Tente outro dia, período ou termo de busca.</p><button onClick={() => { setView("explore"); setPeriod("Todos"); setQuery(""); }}>Limpar filtros</button></div>}
    </section>

    <footer><span>Projeto independente</span><a href="https://congregacaocristanobrasil.org.br/relatorio" target="_blank" rel="noreferrer">Consultar relatório oficial</a></footer>

    {locationOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLocationOpen(false); }}>
      <section className="location-modal" role="dialog" aria-modal="true" aria-labelledby="location-title">
        <div className="modal-head"><div><h2 id="location-title">Localização de saída</h2><p>Para ordenar as casas mais próximas.</p></div><button onClick={() => setLocationOpen(false)} aria-label="Fechar"><X /></button></div>
        <button className="current-location-card" onClick={useCurrentLocation} disabled={locating}><Crosshair size={20} /><span><b>Usar localização atual</b><small>Localização do aparelho</small></span>{locating ? <LoaderCircle className="spin" /> : <ChevronDown size={17} />}</button>
        {places.length > 0 && <div className="saved-places"><label>Salvos</label>{places.map((place) => <div className={origin?.id === place.id ? "saved-place active" : "saved-place"} key={place.id}><button onClick={() => selectOrigin(place)}><MapPinned size={17} /><span><b>{place.name}</b><small>{place.address}</small></span>{origin?.id === place.id && <Check size={16} />}</button><button onClick={() => removePlace(place.id)} aria-label={`Excluir ${place.name}`}><Trash2 size={16} /></button></div>)}</div>}
        <div className="divider"><span>Salvar endereço</span></div>
        <form onSubmit={savePlace} className="place-form"><label>Nome<input value={placeName} onChange={(event) => setPlaceName(event.target.value)} placeholder="Casa" required /></label><label>Endereço<input value={placeAddress} onChange={(event) => setPlaceAddress(event.target.value)} placeholder="Rua, bairro, cidade e UF" required /></label>{locationError && <p className="form-error"><Info size={15} /> {locationError}</p>}<button type="submit" disabled={locating}><Plus size={17} /> Salvar localização</button></form>
        <p className="privacy-note"><ShieldCheck size={14} /> Salvo somente neste aparelho.</p>
      </section>
    </div>}

    {selectedChurch && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedChurch(null); }}>
      <section className="details-modal" role="dialog" aria-modal="true" aria-labelledby="church-details-title">
        <div className="modal-head details-head">
          <div><span className="official-code">{selectedChurch.id}</span><h2 id="church-details-title">{selectedChurch.name}</h2><p>{selectedChurch.city} · {selectedChurch.state}</p></div>
          <button onClick={() => setSelectedChurch(null)} aria-label="Fechar detalhes"><X /></button>
        </div>

        <div className="detail-address"><MapPinned size={18} /><span><b>Localização</b>{selectedChurch.address}</span></div>

        <div className="detail-section">
          <h3><Church size={17} /> Dias de culto</h3>
          <div className="detail-services">{selectedChurch.services.map((service: Service, index: number) => <div key={`${service.day}-${service.time}-${index}`}><span>{DAYS.find((item) => item.short === service.day)?.long ?? service.day}</span><b>{service.time}</b><small>{service.type}</small></div>)}</div>
        </div>

        <div className="detail-section">
          <h3><Users size={17} /> Ministério</h3>
          {selectedChurch.ministry.length ? <div className="ministry-list">{selectedChurch.ministry.map((group) => <div key={group.role}><b>{group.role}</b>{group.names.map((name) => <span key={name}>{name}</span>)}</div>)}</div> : <p className="not-informed">Não informado no relatório oficial.</p>}
        </div>

        <div className="detail-section">
          <h3><Phone size={17} /> Telefone(s)</h3>
          {selectedChurch.phones.length ? <div className="phone-list">{selectedChurch.phones.map((phone) => <a href={`tel:${phone.replace(/[^+\d]/g, "")}`} key={phone}>{phone}</a>)}</div> : <p className="not-informed">Não informado no relatório oficial.</p>}
        </div>

        <div className="route-actions detail-routes">
          <a className="maps-button" href={googleMapsRouteUrl(selectedChurch, origin)} target="_blank" rel="noreferrer"><MapPin size={18} /> Google Maps <ArrowUpRight size={15} /></a>
          <a className="waze-button" href={selectedChurch.wazeUrl} target="_blank" rel="noreferrer"><Navigation size={18} fill="currentColor" /> Waze <ArrowUpRight size={15} /></a>
        </div>
        <a className="official-source" href={selectedChurch.sourceUrl} target="_blank" rel="noreferrer"><ShieldCheck size={14} /> Dados conferidos no relatório oficial da CCB</a>
      </section>
    </div>}
  </main>;
}
