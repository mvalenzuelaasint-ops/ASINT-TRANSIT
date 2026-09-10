import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, NgZone, OnDestroy, signal, ViewChild } from '@angular/core';
import * as L from 'leaflet';
import { firstValueFrom } from 'rxjs';

// El proxy de Netlify mata cualquier respuesta que tarde mas de 26 s.
// Previsualizar (ETL del GTFS completo) y ejecutar (heuristica encadenada)
// pueden tardar mas que eso con feeds grandes, asi que ambos llamados van
// directo a Render (ver planning-heuristic.page.ts para el mismo patron).
const RENDER_BACKEND = 'https://asint-transit.onrender.com';

// Render free corta cualquier subida de mas de ~10 MB con un 502 casi
// instantaneo (confirmado en produccion con un archivo de relleno irrelevante:
// el corte depende del tamano de la subida, no de cuanto proceso el script).
// Por eso el GTFS se manda en pedazos chicos en vez de en un solo POST.
const CHUNK_SIZE = 2 * 1024 * 1024;

function longRunUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  return isLocal ? path : `${RENDER_BACKEND}${path}`;
}

interface OutputFile {
  readonly name: string;
  readonly size: number;
  readonly modified: string;
  readonly ext: string;
}

interface StepResponse {
  readonly runId: string;
  readonly success: boolean;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly files?: OutputFile[];
  readonly stdoutTail?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly detail?: string;
}

interface Servicio {
  readonly unidadServicio: string;
  readonly sheetName: string;
  readonly routeId: string;
  readonly nTrips: number;
}

@Component({
  selector: 'app-planning-fleet',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="px-4 py-6 md:px-8 md:py-8">
      <header class="mb-6">
        <p class="font-label text-[10px] font-bold uppercase tracking-widest text-primary">Planificación operacional</p>
        <h1 class="mt-1 font-headline text-2xl font-bold uppercase tracking-tight text-on-surface md:text-3xl">Flota planificada (GTFS)</h1>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          Cargue un GTFS Schedule (.zip) para ver sus servicios en el mapa y calcular la flota
          planificada. El backend extrae distancias, frecuencias y velocidades comerciales del
          GTFS y ejecuta
          <code class="rounded bg-surface-container px-1.5 py-0.5 text-[11px] text-primary">heurística_POs_USs_2026.py</code>
          solo para el servicio (o los servicios) que elijas.
        </p>
        <p class="mt-2 max-w-2xl text-xs text-on-surface-variant">
          Fase 1: usa solo el horario planificado (GTFS Schedule). La comparación contra flota real en
          calle (GTFS Real Time) queda para una fase posterior.
        </p>
      </header>

      <article class="card-accent-secondary mb-6">
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="flex items-center gap-4">
              <span class="material-symbols-outlined text-3xl text-secondary">upload_file</span>
              <div>
                <h3 class="section-title">GTFS Schedule</h3>
                <p class="mt-1 text-xs text-on-surface-variant">Formato: .zip (o .gz si tu fuente entrega el GTFS con esa extensión) con routes.txt, trips.txt, stop_times.txt (calendar/shapes/frequencies si están disponibles). Tamaño máximo 50 MB.</p>
                @if (inputFile()) {
                  <p class="mt-2 font-mono text-xs text-on-surface">
                    {{ inputFile()!.name }}
                    <span class="text-on-surface-variant">({{ formatBytes(inputFile()!.size) }})</span>
                  </p>
                }
              </div>
            </div>

            <div class="flex items-center gap-2">
              <input #fileInput class="hidden" type="file" accept=".zip,.gz" (change)="onFileSelected($event)">
              <button class="btn-secondary" type="button" [disabled]="previewing()" (click)="fileInput.click()">
                <span class="material-symbols-outlined text-sm">folder_open</span>
                {{ inputFile() ? 'Cambiar' : 'Elegir archivo' }}
              </button>
              <button class="btn-primary" type="button" [disabled]="!canPreview()" (click)="previsualizar()">
                @if (previewing()) {
                  <span class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {{ uploadProgress() < 100 ? 'Subiendo ' + uploadProgress() + '%...' : 'Leyendo GTFS...' }}
                } @else {
                  <span class="material-symbols-outlined text-sm">map</span>
                  Previsualizar
                }
              </button>
            </div>
          </div>
        </div>
      </article>

      @if (previewErrorMessage()) {
        <article class="card-accent-error mb-6">
          <div class="flex items-start gap-3">
            <span class="material-symbols-outlined text-2xl text-error">error</span>
            <div class="min-w-0 flex-1">
              <h3 class="font-headline text-sm font-bold uppercase tracking-widest text-error">Error al leer el GTFS</h3>
              <p class="mt-1 text-xs text-on-surface">{{ previewErrorMessage() }}</p>
              @if (previewErrorDetail()) {
                <pre class="mt-3 max-h-64 overflow-auto rounded bg-surface-container p-3 font-mono text-[10px] leading-relaxed text-on-surface-variant">{{ previewErrorDetail() }}</pre>
              }
            </div>
          </div>
        </article>
      }

      @if (previewRunId()) {
        <article class="card mb-6">
          <h3 class="section-title mb-4">Mapa de servicios ({{ servicios().length }})</h3>
          <div #routesMap class="gtfs-map h-[420px] w-full rounded-lg border border-outline-variant/30"></div>
          <p class="mt-2 text-[11px] text-on-surface-variant">
            Trazado simplificado por ruta y sentido a partir de shapes.txt (o de las paradas si el GTFS no trae shapes). Haz clic en una línea para ver el detalle.
          </p>

          <div class="mt-5 flex flex-col gap-3 border-t border-outline-variant/30 pt-4 md:flex-row md:items-center md:justify-between">
            <div class="flex-1">
              <label class="mb-1 block font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                ¿Qué servicio(s) calcular?
              </label>
              <select
                class="w-full max-w-md rounded-lg border border-outline-variant/40 bg-surface px-3 py-2 text-sm text-on-surface"
                [disabled]="running()"
                (change)="onSeleccionChange($event)"
              >
                <option value="TODAS">Todos los servicios (tope de seguridad: primeros {{ maxRutasTodas }} por cantidad de viajes)</option>
                @for (s of servicios(); track s.unidadServicio) {
                  <option [value]="s.unidadServicio">{{ s.unidadServicio }} &middot; {{ s.nTrips }} viajes</option>
                }
              </select>
            </div>
            <button class="btn-primary shrink-0" type="button" [disabled]="running()" (click)="ejecutar()">
              @if (running()) {
                <span class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Ejecutando...
              } @else {
                <span class="material-symbols-outlined text-sm">play_arrow</span>
                Calcular flota
              }
            </button>
          </div>
          @if (running()) {
            <p class="mt-2 text-[11px] text-on-surface-variant">
              Puede tardar varios minutos si elegiste "todos los servicios": la heurística corre una vez por cada uno.
            </p>
          }
        </article>
      }

      @if (runErrorMessage()) {
        <article class="card-accent-error mb-6">
          <div class="flex items-start gap-3">
            <span class="material-symbols-outlined text-2xl text-error">error</span>
            <div class="min-w-0 flex-1">
              <h3 class="font-headline text-sm font-bold uppercase tracking-widest text-error">Error</h3>
              <p class="mt-1 text-xs text-on-surface">{{ runErrorMessage() }}</p>
              @if (runErrorDetail()) {
                <pre class="mt-3 max-h-64 overflow-auto rounded bg-surface-container p-3 font-mono text-[10px] leading-relaxed text-on-surface-variant">{{ runErrorDetail() }}</pre>
              }
            </div>
          </div>
        </article>
      }

      @if (runResult(); as r) {
        @if (r.success) {
          <article class="card-accent-primary mb-6">
            <div class="flex items-start gap-3">
              <span class="material-symbols-outlined text-2xl text-primary">check_circle</span>
              <div class="min-w-0 flex-1">
                <h3 class="font-headline text-sm font-bold uppercase tracking-widest text-primary">Ejecución completada</h3>
                <p class="mt-1 text-xs text-on-surface-variant">
                  {{ (r.durationMs ?? 0) / 1000 | number: '1.1-1' }}s
                  &middot; {{ excelFiles().length }} reportes &middot; {{ imageFiles().length }} gráficos
                </p>
              </div>
            </div>
          </article>

          @if (excelFiles().length > 0) {
            <article class="card mb-6">
              <h3 class="section-title mb-4">Reportes ({{ excelFiles().length }})</h3>
              <ul class="space-y-2">
                @for (f of excelFiles(); track f.name) {
                  <li class="flex items-center justify-between rounded-lg border border-outline-variant/30 p-3">
                    <div class="flex items-center gap-3">
                      <span class="material-symbols-outlined text-secondary">table_view</span>
                      <div>
                        <p class="font-mono text-xs text-on-surface">{{ f.name }}</p>
                        <p class="text-[10px] text-on-surface-variant">{{ formatBytes(f.size) }}</p>
                      </div>
                    </div>
                    <a class="btn-secondary" [href]="fileUrl(r.runId, f.name)" download>
                      <span class="material-symbols-outlined text-sm">download</span>
                      Descargar
                    </a>
                  </li>
                }
              </ul>
            </article>
          }

          @if (imageFiles().length > 0) {
            <article class="card mb-6">
              <h3 class="section-title mb-4">Gráficos de flota por período ({{ imageFiles().length }})</h3>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                @for (f of imageFiles(); track f.name) {
                  <figure class="overflow-hidden rounded-lg border border-outline-variant/30 bg-surface">
                    <a [href]="fileUrl(r.runId, f.name)" target="_blank" rel="noopener">
                      <img class="block h-40 w-full object-contain bg-white" [src]="fileUrl(r.runId, f.name)" [alt]="f.name" loading="lazy">
                    </a>
                    <figcaption class="flex items-center justify-between gap-2 border-t border-outline-variant/30 px-3 py-2">
                      <span class="truncate font-mono text-[10px] text-on-surface-variant" [title]="f.name">{{ f.name }}</span>
                      <a class="text-primary hover:text-primary-dim" [href]="fileUrl(r.runId, f.name)" download [title]="'Descargar ' + f.name">
                        <span class="material-symbols-outlined text-sm">download</span>
                      </a>
                    </figcaption>
                  </figure>
                }
              </div>
            </article>
          }

          @if (r.stdoutTail) {
            <details class="mt-4">
              <summary class="cursor-pointer font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                Ver salida del proceso
              </summary>
              <pre class="mt-2 max-h-80 overflow-auto rounded bg-surface-container p-3 font-mono text-[10px] leading-relaxed text-on-surface-variant">{{ r.stdoutTail }}</pre>
            </details>
          }
        }
      }
    </section>
  `,
})
export class PlanningFleetPage implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly zone = inject(NgZone);

  private map?: L.Map;
  private routesLayer?: L.GeoJSON;

  readonly maxRutasTodas = 25;

  readonly inputFile = signal<File | null>(null);
  readonly previewing = signal(false);
  readonly uploadProgress = signal(0);
  readonly previewRunId = signal<string | null>(null);
  readonly servicios = signal<Servicio[]>([]);
  readonly seleccion = signal('TODAS');
  readonly previewErrorMessage = signal<string | null>(null);
  readonly previewErrorDetail = signal<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- geojson crudo del backend, tipado local en construir_geojson_rutas (Python)
  readonly geojsonData = signal<any>(null);

  readonly running = signal(false);
  readonly runResult = signal<StepResponse | null>(null);
  readonly runErrorMessage = signal<string | null>(null);
  readonly runErrorDetail = signal<string | null>(null);

  readonly canPreview = computed(() => !!this.inputFile() && !this.previewing());

  readonly excelFiles = computed(() =>
    (this.runResult()?.files ?? []).filter((f) => f.ext === '.xlsx' || f.ext === '.xls'),
  );
  readonly imageFiles = computed(() =>
    (this.runResult()?.files ?? []).filter((f) => ['.png', '.jpg', '.jpeg', '.svg'].includes(f.ext)),
  );

  @ViewChild('routesMap')
  set routesMapElement(element: ElementRef<HTMLDivElement> | undefined) {
    if (!element || this.map) return;
    this.initializeMap(element.nativeElement);
  }

  ngOnDestroy(): void {
    this.map?.remove();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.inputFile.set(input.files?.[0] ?? null);
    this.resetAll();
  }

  onSeleccionChange(event: Event): void {
    this.seleccion.set((event.target as HTMLSelectElement).value);
    this.resaltarSeleccion();
  }

  private resetAll(): void {
    this.previewRunId.set(null);
    this.servicios.set([]);
    this.seleccion.set('TODAS');
    this.previewErrorMessage.set(null);
    this.previewErrorDetail.set(null);
    this.geojsonData.set(null);
    this.routesLayer?.remove();
    this.routesLayer = undefined;
    this.clearRunResult();
  }

  private clearRunResult(): void {
    this.runResult.set(null);
    this.runErrorMessage.set(null);
    this.runErrorDetail.set(null);
  }

  async previsualizar(): Promise<void> {
    const file = this.inputFile();
    if (!file) return;

    this.previewing.set(true);
    this.resetAll();
    this.uploadProgress.set(0);

    try {
      const res = await this.subirEnPedazos(file);
      this.previewing.set(false);
      if (!res.success) {
        this.previewErrorMessage.set(res.error || `Python terminó con código ${res.exitCode}.`);
        this.previewErrorDetail.set(res.stderr || res.stdout || res.detail || null);
        return;
      }
      this.previewRunId.set(res.runId);
      const servicios = (res.files ?? []).find((f) => f.name === 'servicios.json');
      const geo = (res.files ?? []).find((f) => f.ext === '.geojson');
      if (servicios) this.loadServicios(res.runId, servicios.name);
      if (geo) this.loadGeojson(res.runId, geo.name);
    } catch (err: unknown) {
      this.previewing.set(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (err as any)?.error ?? {};
      this.previewErrorMessage.set(body.error || (err as any)?.message || 'Error desconocido leyendo el GTFS.');
      this.previewErrorDetail.set(body.stderr || body.stdout || body.detail || null);
    }
  }

  /** Sube el GTFS en pedazos de CHUNK_SIZE (ver comentario arriba) y recién al
   * terminar dispara la previsualización en el backend. */
  private async subirEnPedazos(file: File): Promise<StepResponse> {
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    const init = await firstValueFrom(
      this.http.post<{ uploadId: string }>(longRunUrl('/api/tripy/upload/init'), {
        filename: file.name,
        totalChunks,
      }),
    );

    for (let i = 0; i < totalChunks; i++) {
      const inicio = i * CHUNK_SIZE;
      const pedazo = file.slice(inicio, inicio + CHUNK_SIZE);
      const form = new FormData();
      form.append('uploadId', init.uploadId);
      form.append('chunkIndex', String(i));
      form.append('chunk', pedazo, file.name);
      await firstValueFrom(this.http.post(longRunUrl('/api/tripy/upload/chunk'), form));
      this.uploadProgress.set(Math.round(((i + 1) / totalChunks) * 100));
    }

    return firstValueFrom(
      this.http.post<StepResponse>(longRunUrl('/api/tripy/upload/complete'), {
        uploadId: init.uploadId,
        filename: file.name,
      }),
    );
  }

  ejecutar(): void {
    const runId = this.previewRunId();
    if (!runId) return;

    this.running.set(true);
    this.clearRunResult();

    this.http.post<StepResponse>(longRunUrl('/api/tripy/run'), { runId, seleccion: this.seleccion() }).subscribe({
      next: (res) => {
        this.running.set(false);
        this.runResult.set(res);
        if (!res.success) {
          this.runErrorMessage.set(res.error || `Python terminó con código ${res.exitCode}.`);
          this.runErrorDetail.set(res.stderr || res.stdout || res.detail || null);
        }
      },
      error: (err) => {
        this.running.set(false);
        const body = err.error ?? {};
        this.runErrorMessage.set(body.error || err.message || 'Error desconocido en la ejecución.');
        this.runErrorDetail.set(body.stderr || body.stdout || body.detail || null);
        if (body.runId) {
          this.runResult.set(body);
        }
      },
    });
  }

  fileUrl(runId: string, name: string): string {
    return `/api/tripy/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(name)}`;
  }

  private loadServicios(runId: string, name: string): void {
    this.http.get<Servicio[]>(this.fileUrl(runId, name)).subscribe({
      next: (data) => this.servicios.set(data ?? []),
      error: () => {},
    });
  }

  private loadGeojson(runId: string, name: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.http.get<any>(this.fileUrl(runId, name)).subscribe({
      next: (data) => {
        this.geojsonData.set(data);
        this.tryRenderRoutes();
      },
      // El mapa es un plus visual: si falla la carga del geojson, el resto del
      // flujo (lista de servicios, ejecución) sigue intacto.
      error: () => {},
    });
  }

  private initializeMap(element: HTMLDivElement): void {
    this.zone.runOutsideAngular(() => {
      const map = L.map(element, {
        attributionControl: false,
        scrollWheelZoom: true,
        zoomControl: false,
      }).setView([-33.45, -70.65], 5);

      // CARTO exige API key en basemaps.cartocdn.com desde fines de ago-2026
      // (aparece el watermark "API KEY REQUIRED"); se usan los tiles estándar
      // de OpenStreetMap, que no requieren key.
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        subdomains: 'abc',
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);

      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.control
        .attribution({ position: 'bottomleft', prefix: false })
        .addAttribution('&copy; OpenStreetMap contributors')
        .addTo(map);

      this.map = map;
      window.setTimeout(() => map.invalidateSize(), 0);
      this.tryRenderRoutes();
    });
  }

  private tryRenderRoutes(): void {
    const map = this.map;
    const data = this.geojsonData();
    if (!map || !data) return;

    this.routesLayer?.remove();
    const layer = L.geoJSON(data, {
      style: (feature) => ({
        color: feature?.properties?.color ?? '#1A3A6B',
        weight: 4,
        opacity: 0.85,
      }),
      onEachFeature: (feature, lyr) => {
        const p = feature.properties ?? {};
        lyr.bindPopup(`<strong>${p.nombre ?? p.unidad_servicio ?? ''}</strong><br>Sentido: ${p.sentido ?? ''}`);
      },
    }).addTo(map);

    this.routesLayer = layer;
    this.resaltarSeleccion();
  }

  /** Al elegir un servicio: ese trazado queda a color pleno y el resto se apaga
   * a gris translúcido, con zoom a la extensión de lo seleccionado. Al volver a
   * "TODAS" restaura los colores originales y el zoom a la extensión completa. */
  private resaltarSeleccion(): void {
    const map = this.map;
    const layer = this.routesLayer;
    if (!map || !layer) return;

    const activa = this.seleccion();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seleccionadas: any[] = [];

    layer.eachLayer((lyr: any) => {
      const props = lyr.feature?.properties ?? {};
      const esSeleccionada = activa === 'TODAS' || props.unidad_servicio === activa;
      if (esSeleccionada) {
        lyr.setStyle({ color: props.color ?? '#1A3A6B', weight: 5, opacity: 0.9 });
        lyr.bringToFront();
        seleccionadas.push(lyr);
      } else {
        lyr.setStyle({ color: '#9CA3AF', weight: 3, opacity: 0.25 });
      }
    });

    if (activa === 'TODAS') {
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [32, 32] });
      return;
    }
    if (seleccionadas.length > 0) {
      const grupo = L.featureGroup(seleccionadas);
      const bounds = grupo.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [56, 56], maxZoom: 16 });
    }
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}
