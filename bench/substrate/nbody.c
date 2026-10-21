// The Benchmarks Game's n-body, 5 million steps.
#include "bench.h"

typedef struct { double x, y, z, vx, vy, vz, mass; } body;

static body bodies[5];

static void place(int i, double x, double y, double z, double vx, double vy, double vz, double mass) {
  body *b = bodies + i;
  double days = 365.24, solar_mass = 4 * 3.141592653589793 * 3.141592653589793;
  b->x = x; b->y = y; b->z = z;
  b->vx = vx * days; b->vy = vy * days; b->vz = vz * days;
  b->mass = mass * solar_mass;
}

static void advance(double dt) {
  for (int i = 0; i < 5; i++) {
    body *bi = bodies + i;
    for (int j = i + 1; j < 5; j++) {
      body *bj = bodies + j;
      double dx = bi->x - bj->x, dy = bi->y - bj->y, dz = bi->z - bj->z;
      double d2 = dx * dx + dy * dy + dz * dz;
      double mag = dt / (d2 * __builtin_sqrt(d2));
      bi->vx -= dx * bj->mass * mag;
      bi->vy -= dy * bj->mass * mag;
      bi->vz -= dz * bj->mass * mag;
      bj->vx += dx * bi->mass * mag;
      bj->vy += dy * bi->mass * mag;
      bj->vz += dz * bi->mass * mag;
    }
  }
  for (int i = 0; i < 5; i++) {
    body *b = bodies + i;
    b->x += dt * b->vx;
    b->y += dt * b->vy;
    b->z += dt * b->vz;
  }
}

static double energy(void) {
  double e = 0.0;
  for (int i = 0; i < 5; i++) {
    body *b = bodies + i;
    e += 0.5 * b->mass * (b->vx * b->vx + b->vy * b->vy + b->vz * b->vz);
    for (int j = i + 1; j < 5; j++) {
      body *c = bodies + j;
      double dx = b->x - c->x, dy = b->y - c->y, dz = b->z - c->z;
      e -= b->mass * c->mass / __builtin_sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
  return e;
}

static int64_t bench(void) {
  place(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0);
  place(1, 4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01,
        1.66007664274403694e-03, 7.69901118419740425e-03, -6.90460016972063023e-05, 9.54791938424326609e-04);
  place(2, 8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01,
        -2.76742510726862411e-03, 4.99852801234917238e-03, 2.30417297573763929e-05, 2.85885980666130812e-04);
  place(3, 1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01,
        2.96460137564761618e-03, 2.37847173959480950e-03, -2.96589568540237556e-05, 4.36624404335156298e-05);
  place(4, 1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01,
        2.68067772490389322e-03, 1.62824170038242295e-03, -9.51592254519715870e-05, 5.15138902046611451e-05);
  double px = 0.0, py = 0.0, pz = 0.0;
  body *sun = bodies + 0;
  for (int i = 0; i < 5; i++) {
    body *b = bodies + i;
    px += b->vx * b->mass;
    py += b->vy * b->mass;
    pz += b->vz * b->mass;
  }
  sun->vx = -px / sun->mass;
  sun->vy = -py / sun->mass;
  sun->vz = -pz / sun->mass;
  for (int k = 0; k < 5000000; k++) advance(0.01);
  return (int64_t)(energy() * 1e9);
}

BENCH(bench())
