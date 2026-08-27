import { NextResponse } from "next/server";

type Coordinate = {
  latitude: number;
  longitude: number;
};

type Destination = Coordinate & {
  id: string;
};

const ROUTING_URL = "https://router.project-osrm.org/table/v1/driving";
const BATCH_SIZE = 45;
const MAX_DESTINATIONS = 200;

const isCoordinate = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

const isValidPoint = (point: unknown): point is Coordinate => {
  if (!point || typeof point !== "object") return false;
  const candidate = point as Partial<Coordinate>;
  return isCoordinate(candidate.latitude, -90, 90) && isCoordinate(candidate.longitude, -180, 180);
};

const isValidDestination = (point: unknown): point is Destination => {
  if (!isValidPoint(point)) return false;
  const candidate = point as Partial<Destination>;
  return typeof candidate.id === "string" && candidate.id.length > 0 && candidate.id.length <= 64;
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as { origin?: unknown; destinations?: unknown };

    if (!isValidPoint(body.origin) || !Array.isArray(body.destinations)) {
      return NextResponse.json({ error: "Localização ou destinos inválidos." }, { status: 400 });
    }

    if (body.destinations.length > MAX_DESTINATIONS || !body.destinations.every(isValidDestination)) {
      return NextResponse.json({ error: "Lista de destinos inválida." }, { status: 400 });
    }

    const destinations = body.destinations as Destination[];
    const distances: Record<string, number> = {};

    for (let index = 0; index < destinations.length; index += BATCH_SIZE) {
      const batch = destinations.slice(index, index + BATCH_SIZE);
      const coordinates = [body.origin, ...batch]
        .map(({ longitude, latitude }) => `${longitude},${latitude}`)
        .join(";");
      const url = `${ROUTING_URL}/${coordinates}?sources=0&annotations=distance`;
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": "Relatorio-CCB-Brasilia/1.0" },
        signal: AbortSignal.timeout(12_000),
      });

      if (!response.ok) throw new Error(`Serviço de rotas respondeu ${response.status}`);

      const result = await response.json() as { code?: string; distances?: Array<Array<number | null>> };
      const row = result.distances?.[0];
      if (result.code !== "Ok" || !row) throw new Error("Resposta inválida do serviço de rotas");

      batch.forEach((destination, batchIndex) => {
        const distanceInMeters = row[batchIndex + 1];
        if (typeof distanceInMeters === "number" && Number.isFinite(distanceInMeters)) {
          distances[destination.id] = distanceInMeters / 1000;
        }
      });
    }

    return NextResponse.json({ distances });
  } catch (error) {
    console.error("[api/distances] Falha ao calcular rotas", error);
    return NextResponse.json({ error: "Não foi possível calcular as distâncias agora." }, { status: 502 });
  }
}
