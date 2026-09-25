#pragma once
#define SIGABRT 6
#define SIGSEGV 11
#define SIGINT 2
#define SIGFPE 8
#define SIGILL 4
#define SIGBUS 7
#define SIGTERM 15
typedef void(*sighandler_t)(int);
sighandler_t signal(int,sighandler_t);
int raise(int);
