#pragma once
double fabs(double); double sqrt(double); double sin(double); double cos(double); double tan(double);
double pow(double,double); double floor(double); double ceil(double); double fmod(double,double);
double exp(double); double log(double); double log10(double); double log2(double);
double atan2(double,double); double atan(double); double asin(double); double acos(double);
double round(double); double trunc(double); double sinh(double); double cosh(double); double tanh(double);
double ldexp(double,int); double frexp(double,int*); double hypot(double,double); double cbrt(double);
float sqrtf(float); float fabsf(float); float floorf(float); float ceilf(float);
#define NAN (__builtin_nanf(""))
#define INFINITY (__builtin_inff())
#define HUGE_VAL (__builtin_inf())
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
#define signbit(x) __builtin_signbit(x)
