#pragma once
typedef struct { long a[32]; } jmp_buf[1];
int setjmp(jmp_buf);void longjmp(jmp_buf,int);
