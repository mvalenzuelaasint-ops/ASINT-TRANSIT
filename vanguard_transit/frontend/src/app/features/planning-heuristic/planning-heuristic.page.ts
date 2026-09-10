import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

// El proxy de Netlify mata cualquier respuesta que tarde mas de 26 s.
// Para el POST que dispara la ejecucion Python (2-3 min) llamamos directo
// al backend en Render. Las llamadas cortas (sheets, status, download)
// siguen via el proxy de Netlify con rutas relativas.
const RENDER_BACKEND = 'https://asint-transit.onrender.com';

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

interface RunResponse {
  readonly runId: string;
  readonly success: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly inputFile?: string;
  readonly sheetName?: string | null;
  readonly files?: OutputFile[];
  readonly stdoutTail?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly detail?: string;
}

interface SheetsResponse {
  readonly sheets?: string[];
  readonly error?: string;
  readonly detail?: string;
}

@Component({
  selector: 'app-planning-heuristic',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatAutocompleteModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="px-4 py-6 md:px-8 md:py-8">
      <header class="mb-6">
        <p class="font-label text-[10px] font-bold uppercase tracking-widest text-primary">Planificación operacional</p>
        <h1 class="mt-1 font-headline text-2xl font-bold uppercase tracking-tight text-on-surface md:text-3xl">Por heurística</h1>
        <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
          Cargue el archivo Excel de entrada, elija la hoja a procesar y ejecute el algoritmo
          heurístico
          <code class="rounded bg-surface-container px-1.5 py-0.5 text-[11px] text-primary">heurística_POs_USs_2026.py</code>.
          Los resultados (Excel + gráficos) aparecerán abajo.
        </p>
      </header>

      <article class="card-accent-secondary mb-6">
        <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="flex items-center gap-4">
              <span class="material-symbols-outlined text-3xl text-secondary">upload_file</span>
              <div>
                <h2 class="section-title">Archivo de entrada</h2>
                <p class="mt-1 text-xs text-on-surface-variant">
                  Formato esperado: .xlsx (múltiples hojas). Tamaño máximo 50 MB.
                </p>
                @if (selectedFile()) {
                  <p class="mt-2 font-mono text-xs text-on-surface">
                    {{ selectedFile()!.name }}
                    <span class="text-on-surface-variant">({{ formatBytes(selectedFile()!.size) }})</span>
                  </p>
                }
              </div>
            </div>

            <div class="flex items-center gap-2">
              <input #fileInput class="hidden" type="file" accept=".xlsx,.xls" (change)="onFileSelected($event)">
              <button class="btn-secondary" type="button" [disabled]="running()" (click)="fileInput.click()">
                <span class="material-symbols-outlined text-sm">folder_open</span>
                Elegir archivo
              </button>
              <button class="btn-primary" type="button" [disabled]="!canRun()" (click)="runHeuristic()">
                @if (running()) {
                  <span class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Ejecutándose...
                } @else {
                  <span class="material-symbols-outlined text-sm">play_arrow</span>
                  Ejecutar
                }
              </button>
            </div>
          </div>

          @if (selectedFile()) {
            <div class="border-t border-outline-variant/30 pt-4">
              <label class="mb-2 block font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                Hoja a procesar
              </label>

              @if (loadingSheets()) {
                <p class="flex items-center gap-2 text-xs text-on-surface-variant">
                  <span class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Leyendo hojas del Excel...
                </p>
              } @else if (sheets().length > 0) {
                <mat-form-field appearance="fill" class="w-full max-w-xl">
                  <mat-label>Comience a escribir para filtrar ({{ sheets().length }} hojas)</mat-label>
                  <input
                    matInput
                    type="text"
                    [formControl]="sheetControl"
                    [matAutocomplete]="auto"
                    placeholder="Ej: INPUT_StgoSP_790-PON 1-1"
                  >
                  <mat-autocomplete #auto="matAutocomplete" autoActiveFirstOption>
                    @for (sheet of filteredSheets(); track sheet) {
                      <mat-option [value]="sheet">{{ sheet }}</mat-option>
                    }
                    @if (filteredSheets().length === 0) {
                      <mat-option [disabled]="true">Sin coincidencias</mat-option>
                    }
                  </mat-autocomplete>
                </mat-form-field>
                @if (typedSheet() && !sheetIsValid()) {
                  <p class="text-[11px] text-error">
                    "{{ typedSheet() }}" no coincide con ninguna hoja. Seleccione una de la lista.
                  </p>
                }
              }
            </div>
          }
        </div>
      </article>

      @if (errorMessage()) {
        <article class="card-accent-error mb-6">
          <div class="flex items-start gap-3">
            <span class="material-symbols-outlined text-2xl text-error">error</span>
            <div class="min-w-0 flex-1">
              <h3 class="font-headline text-sm font-bold uppercase tracking-widest text-error">Error</h3>
              <p class="mt-1 text-xs text-on-surface">{{ errorMessage() }}</p>
              @if (errorDetail()) {
                <pre class="mt-3 max-h-64 overflow-auto rounded bg-surface-container p-3 font-mono text-[10px] leading-relaxed text-on-surface-variant">{{ errorDetail() }}</pre>
              }
            </div>
          </div>
        </article>
      }

      @if (result(); as r) {
        @if (r.success) {
          <article class="card-accent-primary mb-6">
            <div class="flex items-start gap-3">
              <span class="material-symbols-outlined text-2xl text-primary">check_circle</span>
              <div class="min-w-0 flex-1">
                <h3 class="font-headline text-sm font-bold uppercase tracking-widest text-primary">Ejecución completada</h3>
                <p class="mt-1 text-xs text-on-surface-variant">
                  Run <span class="font-mono text-on-surface">{{ r.runId }}</span>
                  &middot; {{ (r.durationMs / 1000).toFixed(1) }}s
                  &middot; {{ r.files?.length || 0 }} archivos generados
                  @if (r.sheetName) {
                    &middot; hoja <span class="font-mono text-on-surface">{{ r.sheetName }}</span>
                  }
                </p>
              </div>
            </div>
          </article>

          @if (excelFiles().length > 0) {
            <article class="card mb-6">
              <h3 class="section-title mb-4">Archivos Excel</h3>
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
            <article class="card">
              <h3 class="section-title mb-4">Gráficos ({{ imageFiles().length }})</h3>
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
            <details class="mt-6">
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
export class PlanningHeuristicPage {
  private readonly http = inject(HttpClient);

  readonly selectedFile = signal<File | null>(null);
  readonly sheets = signal<string[]>([]);
  readonly loadingSheets = signal(false);
  readonly running = signal(false);
  readonly result = signal<RunResponse | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly errorDetail = signal<string | null>(null);

  readonly sheetControl = new FormControl<string>('', { nonNullable: true });
  readonly typedSheet = toSignal(this.sheetControl.valueChanges, { initialValue: '' });

  readonly filteredSheets = computed(() => {
    const query = (this.typedSheet() ?? '').toLowerCase().trim();
    const all = this.sheets();
    if (!query) return all;
    return all.filter((s) => s.toLowerCase().includes(query));
  });

  readonly sheetIsValid = computed(() => this.sheets().includes((this.typedSheet() ?? '').trim()));

  readonly canRun = computed(
    () => !!this.selectedFile() && this.sheetIsValid() && !this.running() && !this.loadingSheets(),
  );

  readonly excelFiles = computed(() =>
    (this.result()?.files ?? []).filter((f) => f.ext === '.xlsx' || f.ext === '.xls'),
  );
  readonly imageFiles = computed(() =>
    (this.result()?.files ?? []).filter((f) => ['.png', '.jpg', '.jpeg', '.svg'].includes(f.ext)),
  );

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.selectedFile.set(file);
    this.sheets.set([]);
    this.sheetControl.setValue('', { emitEvent: true });
    this.result.set(null);
    this.errorMessage.set(null);
    this.errorDetail.set(null);
    if (file) {
      this.fetchSheets(file);
    }
  }

  private fetchSheets(file: File): void {
    this.loadingSheets.set(true);
    const form = new FormData();
    form.append('file', file, file.name);

    this.http.post<SheetsResponse>('/api/heuristic/sheets', form).subscribe({
      next: (res) => {
        this.loadingSheets.set(false);
        this.sheets.set(res.sheets ?? []);
      },
      error: (err) => {
        this.loadingSheets.set(false);
        const body = err.error ?? {};
        this.errorMessage.set(body.error || err.message || 'No se pudieron leer las hojas del Excel.');
        this.errorDetail.set(body.detail || null);
      },
    });
  }

  runHeuristic(): void {
    const file = this.selectedFile();
    const sheet = (this.typedSheet() ?? '').trim();
    if (!file || !sheet) return;

    this.running.set(true);
    this.result.set(null);
    this.errorMessage.set(null);
    this.errorDetail.set(null);

    const form = new FormData();
    form.append('file', file, file.name);
    form.append('sheetName', sheet);

    this.http.post<RunResponse>(longRunUrl('/api/heuristic/run'), form).subscribe({
      next: (res) => {
        this.running.set(false);
        this.result.set(res);
        if (!res.success) {
          this.errorMessage.set(res.error || `Python terminó con código ${res.exitCode}.`);
          this.errorDetail.set(res.stderr || res.stdout || res.detail || null);
        }
      },
      error: (err) => {
        this.running.set(false);
        const body = err.error ?? {};
        this.errorMessage.set(body.error || err.message || 'Error desconocido en la ejecución.');
        this.errorDetail.set(body.stderr || body.stdout || body.detail || null);
        if (body.runId) {
          this.result.set(body);
        }
      },
    });
  }

  fileUrl(runId: string, name: string): string {
    return `/api/heuristic/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(name)}`;
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}
