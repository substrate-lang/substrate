extern void *malloc(unsigned long);
extern void *calloc(unsigned long, unsigned long);
extern void *realloc(void *, unsigned long);
extern void free(void *);
extern int twice(int);
int counter = 5;
static const char *greeting = "hello";
const char *messages[] = {"one", "two"};
int zeros[100];
int add(int a, int b) { counter += a; return a + b + counter; }
int (*pick(void))(int, int) { return add; }
int *counter_address(void) { return &counter; }
char *copy(void) { char *p = malloc(6); for (int i = 0; i < 6; i++) p[i] = greeting[i]; return p; }
const char *message(int i) { return messages[i]; }
int call_back(int (*f)(int), int x) { return f(x) + 1; }
int stack_sum(int n) { volatile int a[64]; for (int i = 0; i < 64; i++) a[i] = i * n; int s = 0; for (int i = 0; i < 64; i++) s += a[i]; return s; }
int zero_sum(void) { int s = 0; for (int i = 0; i < 100; i++) s += zeros[i]; return s; }
int by_name(int x) { return twice(x) + 1; }
void *volatile last;
int null_when_too_big(void) {
  char *p = malloc(16);
  last = malloc(4294967295ul); int a = last == 0;
  last = calloc(65536, 65536); int b = last == 0;
  last = realloc(p, 4294967295ul); int c = last == 0;
  free(p);
  return a && b && c;
}
