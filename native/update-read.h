/* Read one inventory file through anchored, no-follow descriptors. Caller
 * verifies length/hash before serving bytes. No shell or arbitrary write route. */
static int update_read(int argc,char **argv) {
 if(argc!=4)return 20;
 int fd=update_root(argv[2]);if(fd<0)return 20;
 const char *input=argv[3];
 if(!*input||*input=='/'||strchr(input,'\\')||strstr(input,"//")){close(fd);return 20;}
 char *path=strdup(input),*save=0;if(!path){close(fd);return 23;}
 char *part=strtok_r(path,"/",&save);
 while(part){
  if(!strcmp(part,".")||!strcmp(part,"..")){free(path);close(fd);return 20;}
  char *next=strtok_r(NULL,"/",&save);
  int n=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|(next?O_DIRECTORY:0));close(fd);fd=n;
  if(fd<0){free(path);return 20;}part=next;
 }
 free(path);struct stat st;
 if(fstat(fd,&st)||!S_ISREG(st.st_mode)||st.st_size<0||st.st_size>67108864){close(fd);return 22;}
 char buffer[16384];unsigned long long total=0;ssize_t n;
 while((n=read(fd,buffer,sizeof(buffer)))>0){total+=(unsigned long long)n;if(total>67108864){close(fd);return 22;}if(fwrite(buffer,1,n,stdout)!=(size_t)n){close(fd);return 23;}}
 close(fd);return n<0?23:0;
}
