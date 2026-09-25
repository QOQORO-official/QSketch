#pragma once
#include <stddef.h>
typedef struct FILE FILE;
extern FILE* stdout; extern FILE* stderr; extern FILE* stdin;
int printf(const char*,...); int fprintf(FILE*,const char*,...); int sprintf(char*,const char*,...);
int snprintf(char*,size_t,const char*,...);
int fputs(const char*,FILE*); int fputc(int,FILE*); size_t fwrite(const void*,size_t,size_t,FILE*);
size_t fread(void*,size_t,size_t,FILE*); int fflush(FILE*); int puts(const char*); int putchar(int);
FILE* fopen(const char*,const char*); int fclose(FILE*);
