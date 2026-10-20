/* Trusted update import: anchor every directory by descriptor. Snapshotting is
 * not validation: caller hashes and validates the resulting private staging tree.
 * Exit 20 path/type, 21 changed association, 22 limits, 23 storage/read failure.
 */
static int update_root(const char *path) {
 if (!path || path[0]!='/') return -1;
 int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
 char *copy=strdup(path+1), *save=0;
 if(!copy){close(fd);return -1;}
 for(char *p=strtok_r(copy,"/",&save);p;p=strtok_r(NULL,"/",&save)) {
  if(!strcmp(p,".")||!strcmp(p,"..")){close(fd);free(copy);return -1;}
  int next=openat(fd,p,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);close(fd);fd=next;
  if(fd<0)break;
 }
 free(copy);return fd;
}
static int update_tree(int source,int target,int depth,size_t *count,unsigned long long *total) {
 if(depth>64)return 22;
 DIR *dir=fdopendir(dup(source));if(!dir)return 23;
 int result=0;struct dirent *entry;
 errno=0;
 while((entry=readdir(dir))) {
  const char *name=entry->d_name;
  if(!strcmp(name,".")||!strcmp(name,".."))continue;
  if(strchr(name,'\\')||strchr(name,':')){result=20;break;}
  struct stat before;
  if(fstatat(source,name,&before,AT_SYMLINK_NOFOLLOW)){result=23;break;}
  if(S_ISDIR(before.st_mode)) {
   int child=openat(source,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
   if(child<0){result=20;break;}
   if(mkdirat(target,name,0700)){close(child);result=23;break;}
   int output=openat(target,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
   if(output<0){close(child);result=23;break;}
   result=update_tree(child,output,depth+1,count,total);
   close(child);close(output);if(result)break;
  } else if(S_ISREG(before.st_mode)) {
   if(++*count>10002){result=22;break;}
   int input=openat(source,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);
   struct stat actual;
   if(input<0){result=20;break;}
   if(fstat(input,&actual)||!S_ISREG(actual.st_mode)){close(input);result=20;break;}
   if(actual.st_size<0||actual.st_size>67108864){close(input);result=22;break;}
   int output=openat(target,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,actual.st_mode&0111?0700:0600);
   if(output<0){close(input);result=23;break;}
   char buffer[65536];unsigned long long filebytes=0;
   for(;;){
    ssize_t bytes=read(input,buffer,sizeof(buffer));
    if(bytes<0){result=23;break;}if(!bytes)break;
    filebytes+=(unsigned long long)bytes;*total+=(unsigned long long)bytes;
    if(filebytes>67108864||*total>536870912){result=22;break;}
    ssize_t offset=0;
    while(offset<bytes){ssize_t written=write(output,buffer+offset,(size_t)(bytes-offset));if(written<=0){result=23;break;}offset+=written;}
    if(result)break;
   }
   if(!result&&fsync(output))result=23;
   close(input);close(output);if(result)break;
  } else {result=20;break;}
  errno=0;
 }
 if(!result&&errno)result=23;
 closedir(dir);if(!result&&fsync(target))result=23;return result;
}
static int update_snapshot(int argc,char **argv) {
 if(argc!=7)return 20;
 int source=update_root(argv[2]);if(source<0)return 20;
 struct stat st;
 if(fstat(source,&st)){close(source);return 23;}
 char *end=0;unsigned long long device=strtoull(argv[4],&end,10);
 if(!*argv[4]||*end){close(source);return 20;}
 unsigned long long inode=strtoull(argv[5],&end,10);
 if(!*argv[5]||*end){close(source);return 20;}
 if((unsigned long long)st.st_dev!=device||(unsigned long long)st.st_ino!=inode){close(source);return 21;}
 /* Relative path is fixed by the host; still reject ambiguous components. */
 char *path=strdup(argv[3]),*save=0;
 if(!path||!*path||*path=='/'||strchr(path,'\\')||strstr(path,"//")){free(path);close(source);return 20;}
 for(char *p=strtok_r(path,"/",&save);p;p=strtok_r(NULL,"/",&save)) {
  if(!strcmp(p,".")||!strcmp(p,"..")){free(path);close(source);return 20;}
  int next=openat(source,p,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);close(source);source=next;
  if(source<0){free(path);return 20;}
 }
 free(path);
 int target=update_root(argv[6]);if(target<0){close(source);return 20;}
 size_t count=0;unsigned long long total=0;
 int result=update_tree(source,target,0,&count,&total);
 close(source);close(target);return result;
}
