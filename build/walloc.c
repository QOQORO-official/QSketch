/* walloc.c -- the entire libc QSketch's wasm module needs.
 *
 * We compile the Nim-generated C with `-nostdlib -ffreestanding` and a set of
 * stub headers, so every libc symbol the runtime actually references has to be
 * provided here. It is deliberately tiny: a bump allocator that grows linear
 * memory on demand (free is a no-op -- Nim's ARC frees a lot, but a drawing
 * session's peak memory is small and monotonic enough that a bump heap is both
 * faster and simpler than a real free list), the handful of mem/str routines
 * Nim calls, and math functions lowered straight to wasm instructions or
 * cheap approximations. No allocation ever traps: memory.grow handles growth.
 */

typedef unsigned long size_t;
extern unsigned char __heap_base;
#define WPAGE 65536u

static unsigned char *g_bump = 0;
static unsigned char *g_end = 0;

static void grow_to(unsigned char *need) {
  unsigned long cur = (unsigned long)__builtin_wasm_memory_size(0) * WPAGE;
  if ((unsigned long)need <= cur) { g_end = (unsigned char *)cur; return; }
  unsigned long want = (unsigned long)need - cur;
  unsigned long pages = (want + WPAGE - 1) / WPAGE + 16; /* headroom */
  __builtin_wasm_memory_grow(0, pages);
  g_end = (unsigned char *)((unsigned long)__builtin_wasm_memory_size(0) * WPAGE);
}

void *malloc(size_t n) {
  if (!g_bump) {
    g_bump = &__heap_base;
    g_end = (unsigned char *)((unsigned long)__builtin_wasm_memory_size(0) * WPAGE);
  }
  n = (n + 15u) & ~(size_t)15u;
  if (g_bump + n > g_end) grow_to(g_bump + n);
  void *p = g_bump;
  g_bump += n;
  return p;
}
void free(void *p) { (void)p; }
void *calloc(size_t a, size_t b) {
  size_t n = a * b;
  unsigned char *p = (unsigned char *)malloc(n);
  for (size_t i = 0; i < n; i++) p[i] = 0;
  return p;
}
void *realloc(void *p, size_t n) {
  unsigned char *q = (unsigned char *)malloc(n);
  if (p) { unsigned char *s = (unsigned char *)p; for (size_t i = 0; i < n; i++) q[i] = s[i]; }
  return q;
}

void *memcpy(void *d, const void *s, size_t n) {
  unsigned char *dd = (unsigned char *)d; const unsigned char *ss = (const unsigned char *)s;
  for (size_t i = 0; i < n; i++) dd[i] = ss[i];
  return d;
}
void *memset(void *d, int c, size_t n) {
  unsigned char *dd = (unsigned char *)d;
  for (size_t i = 0; i < n; i++) dd[i] = (unsigned char)c;
  return d;
}
void *memmove(void *d, const void *s, size_t n) {
  unsigned char *dd = (unsigned char *)d; const unsigned char *ss = (const unsigned char *)s;
  if (dd < ss) { for (size_t i = 0; i < n; i++) dd[i] = ss[i]; }
  else { for (size_t i = n; i > 0; i--) dd[i - 1] = ss[i - 1]; }
  return d;
}
int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = (const unsigned char *)a; const unsigned char *y = (const unsigned char *)b;
  for (size_t i = 0; i < n; i++) { if (x[i] != y[i]) return (int)x[i] - (int)y[i]; }
  return 0;
}
void *memchr(const void *s, int c, size_t n) {
  const unsigned char *p = (const unsigned char *)s;
  for (size_t i = 0; i < n; i++) if (p[i] == (unsigned char)c) return (void *)(p + i);
  return 0;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) {
  while (*a && (*a == *b)) { a++; b++; }
  return (int)(unsigned char)*a - (int)(unsigned char)*b;
}
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)) { } return r; }

/* --- math ---------------------------------------------------------------
 * Only functions with a native wasm instruction may use __builtin_*: for
 * anything else (exp, sin, pow, round, ...) clang lowers the builtin back to a
 * libcall, i.e. the function would call itself forever. Those are either
 * written out by hand below or deliberately left undefined, so an accidental
 * use shows up as a wasm import instead of a hang. */
double fabs(double x) { return __builtin_fabs(x); }
float fabsf(float x) { return __builtin_fabsf(x); }
double sqrt(double x) { return __builtin_sqrt(x); }
float sqrtf(float x) { return __builtin_sqrtf(x); }
double floor(double x) { return __builtin_floor(x); }
float floorf(float x) { return __builtin_floorf(x); }
double ceil(double x) { return __builtin_ceil(x); }
float ceilf(float x) { return __builtin_ceilf(x); }
double trunc(double x) { return __builtin_trunc(x); }
/* round half away from zero, built from instructions wasm does have */
double round(double x) {
  return x < 0.0 ? -__builtin_floor(-x + 0.5) : __builtin_floor(x + 0.5);
}
double fmod(double a, double b) { return a - b * __builtin_trunc(a / b); }
double hypot(double a, double b) { return __builtin_sqrt(a * a + b * b); }
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }

/* Nim's float formatting may reference these; exact via repeated scaling. */
double ldexp(double x, int e) {
  while (e > 0) { x *= 2.0; e--; }
  while (e < 0) { x *= 0.5; e++; }
  return x;
}
double frexp(double x, int *e) {
  int ex = 0;
  if (x == 0.0 || x != x) { *e = 0; return x; }
  while (__builtin_fabs(x) >= 1.0) { x *= 0.5; ex++; }
  while (__builtin_fabs(x) < 0.5) { x *= 2.0; ex--; }
  *e = ex;
  return x;
}

/* --- unreachable stubs: satisfy the linker, never meaningfully called --- */
void abort(void) { __builtin_trap(); }
void exit(int code) { (void)code; __builtin_trap(); }
int raise(int s) { (void)s; return 0; }
typedef void (*sighandler_t)(int);
sighandler_t signal(int s, sighandler_t h) { (void)s; return h; }

/* stdio: the runtime may reference these from error paths; keep them inert
 * so nothing becomes an unresolved wasm import that JS would have to fill. */
int printf(const char *f, ...) { (void)f; return 0; }
int fprintf(void *fp, const char *f, ...) { (void)fp; (void)f; return 0; }
int fputs(const char *s, void *fp) { (void)s; (void)fp; return 0; }
int fputc(int c, void *fp) { (void)fp; return c; }
int fflush(void *fp) { (void)fp; return 0; }
unsigned long fwrite(const void *p, unsigned long a, unsigned long b, void *fp) {
  (void)p; (void)fp; return a * b;
}
void *stdout = 0;
void *stderr = 0;
int errno = 0;
