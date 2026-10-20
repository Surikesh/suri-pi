#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "update-snapshot.h"
#include "update-read.h"
#ifdef __linux__
/* Linux spells the BSD/macOS nanosecond stat fields st_mtim and st_ctim. */
#define st_mtimespec st_mtim
#define st_ctimespec st_ctim
#endif
/* Descriptor-relative reads and atomic writes. No user path is interpolated into a shell. */
#define QUEUE_MAX_FILES 20000
#define QUEUE_MAX_BYTES (256ULL*1024ULL*1024ULL)
static int queue_open_root(const char *root){
 if(!root||root[0]!='/')return -1;int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(fd<0)return -1;
 char *copy=strdup(root),*save=0;if(!copy){close(fd);return -1;}char *part=strtok_r(copy,"/",&save);
 while(part){if(!strcmp(part,".")||!strcmp(part,"..")||strchr(part,'\\')){free(copy);close(fd);return -1;}int next=openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);close(fd);if(next<0){free(copy);return -1;}fd=next;part=strtok_r(NULL,"/",&save);}
 free(copy);return fd;
}
static int queue_mkdir(int rootfd,char *path){
 char *save=0,*part=strtok_r(path,"/",&save);if(!part)return 5;
 while(part){if(!strcmp(part,"..")||strchr(part,'\\'))return 5;if(strcmp(part,".")){int next=openat(rootfd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(next<0&&errno==ENOENT){if(mkdirat(rootfd,part,0700))return 5;next=openat(rootfd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);}close(rootfd);if(next<0)return 5;rootfd=next;}part=strtok_r(NULL,"/",&save);}
 close(rootfd);return 0;
}
static int queue_open_parent(int rootfd,char *path,int create,char **name){
 char *save=0,*part=strtok_r(path,"/",&save);if(!part)return -1;
 while(part){
  if(!strcmp(part,"..")||strchr(part,'\\'))return -1;
  char *next=strtok_r(NULL,"/",&save);
  if(!next){*name=part;return rootfd;}
  if(strcmp(part,".")){
   int n=openat(rootfd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
   if(n<0&&create&&errno==ENOENT){if(mkdirat(rootfd,part,0700))return -1;n=openat(rootfd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);}
   if(n<0)return -1;close(rootfd);rootfd=n;
  }
  part=next;
 }
 return -1;
}
static int queue_write(int rootfd,char *path){
 char *name=0;int parent=queue_open_parent(rootfd,path,1,&name);if(parent<0||!name||!strcmp(name,"."))return 5;
 char temporary[80];snprintf(temporary,sizeof(temporary),".suri-queue-%ld",(long)getpid());
 int output=openat(parent,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(output<0)return 5;
 char buffer[16384];size_t total=0;int status=0;
 for(;;){ssize_t n=read(0,buffer,sizeof(buffer));if(n<0){status=6;break;}if(!n)break;total+=(size_t)n;if(total>1048576||write(output,buffer,(size_t)n)!=n){status=6;break;}}
 if(!status&&(fsync(output)||close(output))){status=6;output=-1;}else if(output>=0)close(output);
 if(!status&&renameat(parent,temporary,parent,name))status=6;
 if(status)unlinkat(parent,temporary,0);else fsync(parent);close(parent);return status;
}
typedef struct { unsigned long files; unsigned long long bytes; } queue_limits;
static int queue_copy_dir(int source,int target,queue_limits *limits){
 struct stat before,after;if(fstat(source,&before)||!S_ISDIR(before.st_mode))return 5;
 int scan=dup(source);if(scan<0)return 5;DIR *directory=fdopendir(scan);if(!directory){close(scan);return 5;}
 struct dirent *entry;int status=0;
 while(!status&&(entry=readdir(directory))){
  if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
  struct stat item;if(fstatat(source,entry->d_name,&item,AT_SYMLINK_NOFOLLOW)){status=5;break;}
  if(S_ISLNK(item.st_mode)){status=8;break;}
  if(S_ISDIR(item.st_mode)){
   if(mkdirat(target,entry->d_name,0700)){status=6;break;}
   int child_source=openat(source,entry->d_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
   int child_target=openat(target,entry->d_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
   if(child_source<0||child_target<0){if(child_source>=0)close(child_source);if(child_target>=0)close(child_target);status=5;break;}
   status=queue_copy_dir(child_source,child_target,limits);close(child_source);close(child_target);continue;
  }
  if(!S_ISREG(item.st_mode)){status=8;break;}
  int input=openat(source,entry->d_name,O_RDONLY|O_NOFOLLOW);if(input<0){status=5;break;}
  struct stat opened;if(fstat(input,&opened)||!S_ISREG(opened.st_mode)||opened.st_dev!=item.st_dev||opened.st_ino!=item.st_ino){close(input);status=7;break;}
  int output=openat(target,entry->d_name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);if(output<0){close(input);status=6;break;}
  char buffer[16384];for(;;){ssize_t n=read(input,buffer,sizeof(buffer));if(n<0){status=5;break;}if(!n)break;limits->bytes+=(unsigned long long)n;if(limits->bytes>QUEUE_MAX_BYTES||write(output,buffer,(size_t)n)!=n){status=9;break;}}
  struct stat finished;if(!status&&(fstat(input,&finished)||finished.st_size!=opened.st_size||finished.st_mtimespec.tv_sec!=opened.st_mtimespec.tv_sec||finished.st_mtimespec.tv_nsec!=opened.st_mtimespec.tv_nsec||finished.st_ctimespec.tv_sec!=opened.st_ctimespec.tv_sec||finished.st_ctimespec.tv_nsec!=opened.st_ctimespec.tv_nsec))status=7;
  if(!status&&fsync(output))status=6;close(input);close(output);limits->files++;if(limits->files>QUEUE_MAX_FILES)status=9;
 }
 closedir(directory);
 if(!status&&(fstat(source,&after)||after.st_dev!=before.st_dev||after.st_ino!=before.st_ino||after.st_mtimespec.tv_sec!=before.st_mtimespec.tv_sec||after.st_mtimespec.tv_nsec!=before.st_mtimespec.tv_nsec||after.st_ctimespec.tv_sec!=before.st_ctimespec.tv_sec||after.st_ctimespec.tv_nsec!=before.st_ctimespec.tv_nsec))status=7;
 return status;
}
static int queue_copy(char *source_path,char *target_path){
 int source=queue_open_root(source_path);int target=queue_open_root(target_path);if(source<0||target<0){if(source>=0)close(source);if(target>=0)close(target);return 4;}
 queue_limits limits={0,0};int status=queue_copy_dir(source,target,&limits);close(source);close(target);return status;
}
static int write_file(int rootfd,char *path){
 char *save=0,*part=strtok_r(path,"/",&save),*name=0;
 if(!part)return 5;
 while(part){
  if(!strcmp(part,".."))return 5;
  char *next=strtok_r(NULL,"/",&save);
  if(!next){name=part;break;}
  if(strcmp(part,".")){int n=openat(rootfd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(n<0)return 5;close(rootfd);rootfd=n;}
  part=next;
 }
 if(!name||!strcmp(name,"."))return 5;
 int current=openat(rootfd,name,O_RDONLY|O_NOFOLLOW);if(current<0)return 5;
 struct stat before;if(fstat(current,&before)||!S_ISREG(before.st_mode)){close(current);return 5;}
 char temporary[80];snprintf(temporary,sizeof(temporary),".suri-save-%ld",(long)getpid());
 int output=openat(rootfd,temporary,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,before.st_mode&0777);
 if(output<0){close(current);return 5;}
 if(fchmod(output,before.st_mode&07777)){close(output);close(current);unlinkat(rootfd,temporary,0);return 6;}
 char buffer[16384];size_t total=0;int status=0;
 for(;;){ssize_t n=read(0,buffer,sizeof(buffer));if(n<0){status=6;break;}if(!n)break;total+=(size_t)n;if(total>1048576||write(output,buffer,(size_t)n)!=n){status=6;break;}}
 if(!status&&(fsync(output)||close(output))){status=6;output=-1;}else if(output>=0)close(output);
 struct stat now;
 if(!status&&(fstatat(rootfd,name,&now,AT_SYMLINK_NOFOLLOW)||now.st_dev!=before.st_dev||now.st_ino!=before.st_ino))status=7;
 close(current);
 if(!status&&renameat(rootfd,temporary,rootfd,name))status=6;
 if(status)unlinkat(rootfd,temporary,0);else fsync(rootfd);
 close(rootfd);return status;
}
int main(int argc,char **argv){
 if(argc<3)return 2;
 if(!strcmp(argv[1],"update-snapshot"))return update_snapshot(argc,argv);
 if(!strcmp(argv[1],"update-read"))return update_read(argc,argv);
 if(!strcmp(argv[1],"queue-copy")){if(argc!=4)return 2;return queue_copy(argv[2],argv[3]);}
 if(!strcmp(argv[1],"lock")){int fd=open(argv[2],O_CREAT|O_RDWR|O_NOFOLLOW,0600);if(fd<0||flock(fd,LOCK_EX|LOCK_NB))return 3;puts("locked");fflush(stdout);char c;while(read(0,&c,1)>0){}close(fd);return 0;}
 if(argc<4)return 2;int queue=!strcmp(argv[1],"queue-write")||!strcmp(argv[1],"queue-read")||!strcmp(argv[1],"queue-mkdir");int fd=queue?queue_open_root(argv[2]):open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(fd<0)return 4;
 char *path=strdup(argv[3]);if(!path||path[0]=='/'||strchr(path,'\\'))return 5;
 if(!strcmp(argv[1],"queue-mkdir")){int result=queue_mkdir(fd,path);free(path);return result;}
 if(!strcmp(argv[1],"queue-write")){int result=queue_write(fd,path);free(path);return result;}
 if(!strcmp(argv[1],"write")){int result=write_file(fd,path);free(path);return result;}
 char *save=0,*part=strtok_r(path,"/",&save);while(part){if(!strcmp(part,".."))return 5;if(strcmp(part,".")){char *next=strtok_r(NULL,"/",&save);int n=openat(fd,part,O_RDONLY|O_NOFOLLOW|(next?O_DIRECTORY:0));close(fd);if(n<0)return 5;fd=n;part=next;}else part=strtok_r(NULL,"/",&save);}
 struct stat st;if(fstat(fd,&st))return 5;
 if(!strcmp(argv[1],"list")){if(!S_ISDIR(st.st_mode))return 5;DIR *d=fdopendir(fd);if(!d)return 5;struct dirent *e;int count=0;long skip=argc>4?strtol(argv[4],0,10):0;if(skip<0||skip>1000000)return 5;while((e=readdir(d))&&count<501){if(!strcmp(e->d_name,".")||!strcmp(e->d_name,".."))continue;if(skip>0){skip--;continue;}struct stat s;if(fstatat(fd,e->d_name,&s,AT_SYMLINK_NOFOLLOW))continue;char kind=S_ISLNK(s.st_mode)?'l':S_ISDIR(s.st_mode)?'d':'f';fputc(kind,stdout);fwrite(e->d_name,1,strlen(e->d_name)+1,stdout);count++;}closedir(d);return 0;}
 if(strcmp(argv[1],"read")&&strcmp(argv[1],"queue-read"))return 5;if(!S_ISREG(st.st_mode))return 5;
 if(!strcmp(argv[1],"queue-read")){char buffer[16384];size_t total=0;for(;;){ssize_t n=read(fd,buffer,sizeof(buffer));if(n<0)return 5;if(!n)break;total+=(size_t)n;if(total>1048576)return 9;if(fwrite(buffer,1,(size_t)n,stdout)!=(size_t)n)return 6;}close(fd);free(path);return 0;}
 long off=argc>4?strtol(argv[4],0,10):0;long limit=argc>5?strtol(argv[5],0,10):1048576;if(off<0||limit<1||limit>1048577)return 5;if(lseek(fd,off,SEEK_SET)<0)return 5;
 char buffer[16384];while(limit>0){ssize_t n=read(fd,buffer,limit<16384?limit:16384);if(n<0)return 5;if(!n)break;if(fwrite(buffer,1,n,stdout)!=(size_t)n)return 6;limit-=n;}close(fd);free(path);return 0;
}
